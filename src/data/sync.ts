import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import { create } from 'zustand'
import { db, getMeta, setMeta } from './db'
import { observeTimestamp } from './clock'
import { emitStrokes, localChanges } from './repo'
import { parseBackground } from '../engine/background'
import { fileAvailable } from '../engine/pdfBackgrounds'
import { imageFileId } from '../engine/images'
import type { FileRow, StrokeRow } from '../engine/types'
import { supabase } from './supabase'
import { fromWire, shouldApplyRemote, toWire, type LocalRow, type RemoteRow, type TableName } from './wire'

export type SyncState = 'signed-out' | 'offline' | 'syncing' | 'synced' | 'error'

interface SyncStatus {
  state: SyncState
  pending: number
  lastSyncedAt: number | null
  error: string | null
}

export const useSyncStatus = create<SyncStatus>(() => ({ state: 'signed-out', pending: 0, lastSyncedAt: null, error: null }))

const TABLES: TableName[] = ['notebooks', 'pages', 'strokes']
const PAGE_SIZE = 1000
/** Re-read this much history on each pull to catch rows whose transactions committed late. */
const PULL_OVERLAP_MS = 5000
const PUSH_DEBOUNCE_MS = 600
/** Keep RPC payloads well under request limits; strokes are the heavy rows. */
const MAX_BATCH_BYTES = 512 * 1024
const PDF_BUCKET = 'pdfs'
const IMAGE_BUCKET = 'images'

/** Storage bucket and object name for a file: PDFs and images live apart, with their own type limits. */
function storageLocation(userId: string, fileId: string, type = 'application/pdf') {
  if (type === 'application/pdf') return { bucket: PDF_BUCKET, path: `${userId}/${fileId}.pdf` }
  return { bucket: IMAGE_BUCKET, path: `${userId}/${fileId}.${type === 'image/png' ? 'png' : 'jpg'}` }
}

function table(name: TableName) {
  return db.table<LocalRow, string>(name)
}

class SyncEngine {
  private userId: string | null = null
  private channel: RealtimeChannel | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private pushing = false
  private pushAgain = false
  private pulling: Promise<void> | null = null
  private retryDelay = 2000

  constructor() {
    localChanges.addEventListener('change', () => {
      void this.refreshPending()
      this.schedulePush()
    })
    window.addEventListener('online', () => this.resume())
    window.addEventListener('offline', () => this.setState('offline'))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.resume()
      else void this.pushNow()
    })
    // Safety net in case a realtime event is ever dropped: a cheap incremental pull.
    setInterval(() => {
      if (this.userId && navigator.onLine && document.visibilityState === 'visible') void this.pull()
    }, 45000)
  }

  private setState(state: SyncState, error: string | null = null) {
    useSyncStatus.setState({ state, error, ...(state === 'synced' ? { lastSyncedAt: Date.now() } : {}) })
  }

  async refreshPending() {
    let pending = 0
    for (const t of TABLES) pending += await table(t).where('dirty').equals(1).count()
    pending += await db.files.where('dirty').equals(1).count()
    useSyncStatus.setState({ pending })
    return pending
  }

  async start(session: Session) {
    const uid = session.user.id
    if (this.userId === uid) return
    await this.stop()
    await this.adoptLocalData(uid)
    this.userId = uid
    this.subscribe()
    await this.resume()
  }

  async stop() {
    this.userId = null
    if (this.channel) await supabase.removeChannel(this.channel)
    this.channel = null
    this.setState('signed-out')
  }

  /**
   * Notes written before signing in become the account's notes. Data from a
   * different account is never mixed in: the caller clears it on sign-out.
   */
  private async adoptLocalData(uid: string) {
    const owner = await getMeta<string | null>('owner', null)
    if (owner && owner !== uid) {
      await clearLocalData()
    } else if (!owner) {
      for (const t of TABLES) await table(t).toCollection().modify({ dirty: 1 })
      await db.files.toCollection().modify({ dirty: 1 })
    }
    await setMeta('owner', uid)
  }

  private subscribe() {
    const uid = this.userId!
    let channel = supabase.channel(`sync:${uid}`)
    for (const t of TABLES) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: t, filter: `user_id=eq.${uid}` },
        (payload) => {
          if (payload.new && 'id' in payload.new) void this.applyRemote(t, [payload.new as RemoteRow])
        },
      )
    }
    this.channel = channel.subscribe((status) => {
      // (Re)subscribing can miss events while disconnected; catch up with a pull.
      if (status === 'SUBSCRIBED') {
        this.resubscribeDelay = 2000
        void this.pull()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // A broken channel never recovers by itself; rebuild it with backoff.
        const delay = this.resubscribeDelay
        this.resubscribeDelay = Math.min(delay * 2, 60000)
        setTimeout(() => {
          if (this.userId !== uid || !this.channel) return
          void supabase.removeChannel(this.channel).then(() => this.userId === uid && this.subscribe())
        }, delay)
      }
    })
  }

  private resubscribeDelay = 2000

  async resume() {
    if (!this.userId) return
    if (!navigator.onLine) return this.setState('offline')
    await this.pull()
    await this.pushNow()
  }

  schedulePush() {
    if (!this.userId) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.pushNow(), PUSH_DEBOUNCE_MS)
  }

  async pushNow(): Promise<void> {
    if (!this.userId || !navigator.onLine) return
    if (this.pushing) {
      this.pushAgain = true
      return
    }
    this.pushing = true
    this.setState('syncing')
    try {
      // Files first, so a page never reaches another device before its PDF or images do.
      await this.pushFiles()
      for (const t of TABLES) await this.pushTable(t)
      this.retryDelay = 2000
      const pending = await this.refreshPending()
      this.setState(pending ? 'syncing' : 'synced')
    } catch (e) {
      this.setState(navigator.onLine ? 'error' : 'offline', e instanceof Error ? e.message : String(e))
      const delay = this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, 60000)
      setTimeout(() => this.schedulePush(), delay)
    } finally {
      this.pushing = false
      if (this.pushAgain) {
        this.pushAgain = false
        void this.pushNow()
      }
    }
  }

  private async pushFiles() {
    const keys = await db.files.where('dirty').equals(1).primaryKeys()
    for (const id of keys) {
      const file = await db.files.get(id)
      if (!file?.dirty) continue
      const type = file.type ?? 'application/pdf'
      const { bucket, path } = storageLocation(this.userId!, id, type)
      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, new Blob([file.data], { type }), { contentType: type, upsert: false })
      // Files are immutable, so "already exists" means an earlier upload landed.
      if (error && !isDuplicate(error)) throw new Error(error.message)
      await db.files.update(id, { dirty: 0 })
    }
  }

  /** Fetches a file from Storage and keeps it locally for offline use. */
  async downloadFile(fileId: string, type = 'application/pdf'): Promise<ArrayBuffer> {
    const existing = this.downloads.get(fileId)
    if (existing) return existing
    const p = (async () => {
      if (!this.userId) throw new Error('Inicia sesión para descargar este archivo')
      const { bucket, path } = storageLocation(this.userId, fileId, type)
      let { data, error } = await supabase.storage.from(bucket).download(path)
      // Images are stored as .jpg or .png; the page only knows it is an image.
      if (!data && type === 'image/jpeg') ({ data, error } = await supabase.storage.from(bucket).download(storageLocation(this.userId, fileId, 'image/png').path))
      if (error || !data) throw new Error(error?.message ?? 'Download failed')
      const bytes = await data.arrayBuffer()
      const stored = type === 'application/pdf' ? type : data.type.startsWith('image/') ? data.type : type
      const row: FileRow = { id: fileId, type: stored, data: bytes, size: bytes.byteLength, dirty: 0 }
      // Never overwrite a local copy that still has to be uploaded.
      await db.transaction('rw', db.files, async () => {
        if (!(await db.files.get(fileId))) await db.files.add(row)
      })
      fileAvailable(fileId)
      return bytes
    })().finally(() => this.downloads.delete(fileId))
    this.downloads.set(fileId, p)
    return p
  }

  private downloads = new Map<string, Promise<ArrayBuffer>>()

  /** Downloads PDFs and images that live pages reference but this device lacks, so they open offline later. */
  private async prefetchFiles() {
    const ids = new Map<string, string>()
    await db.pages.each((p) => {
      const bg = !p.deleted && parseBackground(p.background)
      if (bg) ids.set(bg.fileId, 'application/pdf')
    })
    await db.strokes.each((s) => {
      const id = !s.deleted && imageFileId(s)
      if (id) ids.set(id, 'image/jpeg')
    })
    const have = new Set(await db.files.toCollection().primaryKeys())
    for (const [id, type] of ids) {
      if (have.has(id) || !this.userId || !navigator.onLine) continue
      try {
        await this.downloadFile(id, type)
      } catch (e) {
        console.warn('File prefetch failed', id, e)
      }
    }
  }

  private async pushTable(t: TableName) {
    for (;;) {
      const dirty = await table(t).where('dirty').equals(1).limit(2000).toArray()
      if (!dirty.length) return
      let batch: LocalRow[] = []
      let wire: Record<string, unknown>[] = []
      let bytes = 0
      const flush = async () => {
        if (!wire.length) return
        const { error } = await supabase.rpc(`push_${t}`, { rows: wire })
        if (error) throw new Error(error.message)
        const sent = batch
        await db.transaction('rw', table(t), async () => {
          for (const row of sent) {
            const current = await table(t).get(row.id)
            // Only clear the flag if nothing changed while the request was in flight.
            if (current && current.updated_at === row.updated_at) await table(t).update(row.id, { dirty: 0 })
          }
        })
        batch = []
        wire = []
        bytes = 0
      }
      for (const row of dirty) {
        const w = toWire(t, row)
        const size = JSON.stringify(w).length
        if (bytes + size > MAX_BATCH_BYTES) await flush()
        batch.push(row)
        wire.push(w)
        bytes += size
      }
      await flush()
      if (dirty.length < 2000) return
    }
  }

  pull(): Promise<void> {
    if (!this.userId) return Promise.resolve()
    // Coalesce concurrent pulls (realtime resubscribe + visibility change + start).
    this.pulling ??= this.doPull().finally(() => (this.pulling = null))
    return this.pulling
  }

  private async doPull() {
    // No 'syncing' state here: background pulls would make the badge flicker.
    try {
      for (const t of TABLES) await this.pullTable(t)
      void this.prefetchFiles()
      const pending = await this.refreshPending()
      this.setState(pending ? 'syncing' : 'synced')
    } catch (e) {
      this.setState(navigator.onLine ? 'error' : 'offline', e instanceof Error ? e.message : String(e))
    }
  }

  private async pullTable(t: TableName) {
    const key = `cursor:${t}`
    const saved = await getMeta<string | null>(key, null)
    let since = saved ? new Date(new Date(saved).getTime() - PULL_OVERLAP_MS).toISOString() : null
    for (;;) {
      let q = supabase.from(t).select('*').order('server_ts', { ascending: true }).limit(PAGE_SIZE)
      if (since) q = q.gte('server_ts', since)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as RemoteRow[]
      if (rows.length) await this.applyRemote(t, rows)
      const maxTs = rows.at(-1)?.server_ts
      if (maxTs) {
        const prev = await getMeta<string | null>(key, null)
        if (!prev || maxTs > prev) await setMeta(key, maxTs)
      }
      if (rows.length < PAGE_SIZE || !maxTs || maxTs === since) return
      since = maxTs
    }
  }

  private async applyRemote(t: TableName, rows: RemoteRow[]) {
    const applied: LocalRow[] = []
    await db.transaction('rw', table(t), async () => {
      for (const remote of rows) {
        const updatedAt = Number(remote.updated_at)
        observeTimestamp(updatedAt)
        const local = await table(t).get(remote.id)
        if (shouldApplyRemote(local, updatedAt)) {
          const row = fromWire(t, remote)
          await table(t).put(row)
          applied.push(row)
        }
      }
    })
    if (t === 'strokes') emitStrokes(applied as StrokeRow[], 'remote')
  }
}

export async function clearLocalData() {
  await db.transaction('rw', [db.notebooks, db.pages, db.strokes, db.meta, db.files], async () => {
    await Promise.all([db.notebooks.clear(), db.pages.clear(), db.strokes.clear(), db.meta.clear(), db.files.clear()])
  })
}

function isDuplicate(error: { message: string; statusCode?: string | number }) {
  return String(error.statusCode) === '409' || /already exists|duplicate/i.test(error.message)
}

export const sync = new SyncEngine()
