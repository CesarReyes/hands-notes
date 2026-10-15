import Dexie, { type EntityTable } from 'dexie'
import type { NotebookRow, PageRow, StrokeRow } from '../engine/types'

export interface MetaRow {
  key: string
  value: unknown
}

export class NotesDB extends Dexie {
  notebooks!: EntityTable<NotebookRow, 'id'>
  pages!: EntityTable<PageRow, 'id'>
  strokes!: EntityTable<StrokeRow, 'id'>
  meta!: EntityTable<MetaRow, 'key'>

  constructor(name = 'hands-notes') {
    super(name)
    this.version(1).stores({
      notebooks: 'id, updated_at, dirty',
      pages: 'id, notebook_id, dirty',
      strokes: 'id, page_id, notebook_id, dirty',
      meta: 'key',
    })
  }
}

export const db = new NotesDB()

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row ? (row.value as T) : fallback
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value })
}
