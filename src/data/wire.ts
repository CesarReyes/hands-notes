import { decodePoints, encodePoints } from '../engine/encoding'
import type { NotebookRow, PageRow, StrokeRow } from '../engine/types'

export type TableName = 'notebooks' | 'pages' | 'strokes'
export type LocalRow = NotebookRow | PageRow | StrokeRow
export type RemoteRow = Record<string, unknown> & { id: string; updated_at: number; server_ts?: string }

/** Local row → RPC payload (user_id and server_ts are always set server-side). */
export function toWire(table: TableName, row: LocalRow): Record<string, unknown> {
  const { dirty: _dirty, ...rest } = row as LocalRow & { dirty: number }
  if (table === 'strokes') {
    const s = rest as Omit<StrokeRow, 'dirty'>
    return { ...s, points: encodePoints(s.points) }
  }
  // Rows written before backgrounds existed have no field; send an explicit null.
  if (table === 'pages') return { ...rest, background: (rest as Partial<PageRow>).background ?? null }
  return rest
}

/** Server row → local row (clean). */
export function fromWire(table: TableName, remote: RemoteRow): LocalRow {
  const { user_id: _u, server_ts: _ts, ...rest } = remote
  const row = { ...rest, updated_at: Number(remote.updated_at), dirty: 0 } as Record<string, unknown>
  if (table === 'notebooks') row.created_at = Number(remote.created_at)
  if (table === 'strokes') row.points = decodePoints(remote.points as string)
  if (table === 'pages') row.background = typeof remote.background === 'string' && remote.background ? remote.background : null
  return row as unknown as LocalRow
}

/**
 * Last-writer-wins merge decision. A local row with unpushed edits only yields
 * to a strictly newer remote version; equal timestamps mean it's our own echo.
 */
export function shouldApplyRemote(local: { updated_at: number; dirty: number } | undefined, remoteUpdatedAt: number): boolean {
  if (!local) return true
  if (local.dirty) return remoteUpdatedAt > local.updated_at
  return remoteUpdatedAt >= local.updated_at
}
