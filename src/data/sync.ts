import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import { create } from 'zustand'
import { db, getMeta, setMeta } from './db'
import { observeTimestamp } from './clock'
import { emitStrokes, localChanges } from './repo'
import type { StrokeRow } from '../engine/types'
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
  await db.transaction('rw', [db.notebooks, db.pages, db.strokes, db.meta], async () => {
    await Promise.all([db.notebooks.clear(), db.pages.clear(), db.strokes.clear(), db.meta.clear()])
  })
}

export const sync = new SyncEngine()
