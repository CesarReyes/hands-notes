import { db } from './db'
import { nextTimestamp } from './clock'
import { uuidv7 } from './ids'
import { pdfBackground } from '../engine/background'
import { openPdf } from '../engine/pdfjs'
import { PAGE_HEIGHT, PAGE_WIDTH, type FileRow, type NotebookRow, type PageRow, type Paper, type StrokeRow, type Template } from '../engine/types'

/** Fired after every local write so the sync engine can push. */
export const localChanges = new EventTarget()

function changed() {
  localChanges.dispatchEvent(new Event('change'))
}

export const COVER_COLORS = ['#3b5bdb', '#2b8a3e', '#c2255c', '#e8590c', '#5f3dc4', '#0b7285', '#495057', '#d9480f']

export async function createNotebook(title: string, cover: string, template: Template, paper: Paper): Promise<string> {
  const now = nextTimestamp()
  const notebook: NotebookRow = { id: uuidv7(), title, cover, created_at: now, updated_at: now, deleted: false, dirty: 1 }
  const page = newPage(notebook.id, 1, template, paper)
  await db.transaction('rw', db.notebooks, db.pages, async () => {
    await db.notebooks.add(notebook)
    await db.pages.add(page)
  })
  changed()
  return notebook.id
}

function newPage(notebookId: string, position: number, template: Template, paper: Paper, background: string | null = null, height = PAGE_HEIGHT): PageRow {
  return {
    id: uuidv7(),
    notebook_id: notebookId,
    position,
    template,
    paper,
    width: PAGE_WIDTH,
    height,
    background,
    updated_at: nextTimestamp(),
    deleted: false,
    dirty: 1,
  }
}

export async function updateNotebook(id: string, patch: Partial<Pick<NotebookRow, 'title' | 'cover' | 'deleted'>>) {
  await db.notebooks.update(id, { ...patch, updated_at: nextTimestamp(), dirty: 1 })
  changed()
}

/** Marks the notebook as touched so it sorts first in the library. */
export async function touchNotebook(id: string) {
  await db.notebooks.update(id, { updated_at: nextTimestamp(), dirty: 1 })
  changed()
}

export async function livePages(notebookId: string): Promise<PageRow[]> {
  const pages = await db.pages.where('notebook_id').equals(notebookId).toArray()
  return pages.filter((p) => !p.deleted).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
}

export const MAX_PDF_BYTES = 50 * 1024 * 1024

/** An import failure with a message fit to show the user. */
export class ImportError extends Error {}

/**
 * Imports a PDF as a new notebook: one page per PDF page, with the PDF page as
 * its background. The bytes are kept locally and uploaded to Storage by sync.
 */
export async function importPdf(file: File, cover: string): Promise<string> {
  // Matches the Storage bucket's limit; a bigger file could never upload and would stall sync.
  if (file.size > MAX_PDF_BYTES) throw new ImportError(`“${file.name}” pesa más de ${MAX_PDF_BYTES / 1024 / 1024} MB.`)
  const data = await file.arrayBuffer()
  const pdf = await openPdf(data)
  const sizes: { w: number; h: number }[] = []
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const vp = (await pdf.getPage(n)).getViewport({ scale: 1 })
      sizes.push({ w: vp.width, h: vp.height })
    }
  } finally {
    void pdf.loadingTask.destroy()
  }
  if (!sizes.length) throw new ImportError(`“${file.name}” no tiene páginas.`)

  const now = nextTimestamp()
  const fileRow: FileRow = { id: uuidv7(), data, size: data.byteLength, dirty: 1 }
  const title = file.name.replace(/\.pdf$/i, '').trim() || 'PDF'
  const notebook: NotebookRow = { id: uuidv7(), title, cover, created_at: now, updated_at: now, deleted: false, dirty: 1 }
  // Same width as every page; the height keeps the PDF page's aspect ratio.
  const pages = sizes.map(({ w, h }, i) =>
    newPage(notebook.id, i + 1, 'blank', 'white', pdfBackground(fileRow.id, i + 1), Math.round((PAGE_WIDTH * h) / w)),
  )
  await db.transaction('rw', db.files, db.notebooks, db.pages, async () => {
    await db.files.add(fileRow)
    await db.notebooks.add(notebook)
    await db.pages.bulkAdd(pages)
  })
  changed()
  return notebook.id
}

/** Inserts a page after `afterPageId` (or at the end) and returns its id. */
export async function addPage(
  notebookId: string,
  afterPageId: string | null,
  template: Template,
  paper: Paper,
  background: string | null = null,
  height = PAGE_HEIGHT,
): Promise<string> {
  const pages = await livePages(notebookId)
  let position: number
  const idx = afterPageId ? pages.findIndex((p) => p.id === afterPageId) : pages.length - 1
  if (idx < 0 || idx === pages.length - 1) {
    position = (pages.at(-1)?.position ?? 0) + 1
  } else {
    position = (pages[idx].position + pages[idx + 1].position) / 2
  }
  const page = newPage(notebookId, position, template, paper, background, height)
  await db.pages.add(page)
  await touchNotebook(notebookId)
  return page.id
}

export async function updatePage(id: string, patch: Partial<Pick<PageRow, 'template' | 'paper' | 'deleted' | 'position'>>) {
  const page = await db.pages.get(id)
  await db.pages.update(id, { ...patch, updated_at: nextTimestamp(), dirty: 1 })
  if (page) await touchNotebook(page.notebook_id)
  else changed()
}

export async function movePage(notebookId: string, pageId: string, toIndex: number) {
  const pages = (await livePages(notebookId)).filter((p) => p.id !== pageId)
  const before = pages[toIndex - 1]?.position
  const after = pages[toIndex]?.position
  let position: number
  if (before === undefined && after === undefined) position = 1
  else if (before === undefined) position = after! - 1
  else if (after === undefined) position = before + 1
  else position = (before + after) / 2
  await updatePage(pageId, { position })
}

export async function duplicatePage(notebookId: string, pageId: string): Promise<string> {
  const src = await db.pages.get(pageId)
  if (!src) throw new Error('Page not found')
  const newId = await addPage(notebookId, pageId, src.template, src.paper, src.background ?? null, src.height)
  const strokes = await db.strokes.where('page_id').equals(pageId).toArray()
  const copies = strokes
    .filter((s) => !s.deleted)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((s) => ({ ...s, id: uuidv7(), page_id: newId, updated_at: nextTimestamp(), dirty: 1 as const }))
  await db.strokes.bulkAdd(copies)
  emitStrokes(copies, 'local')
  changed()
  return newId
}

export async function liveStrokes(notebookId: string): Promise<StrokeRow[]> {
  const strokes = await db.strokes.where('notebook_id').equals(notebookId).toArray()
  return strokes.filter((s) => !s.deleted)
}

/**
 * Writes stroke versions exactly as given (callers stamp updated_at with
 * nextTimestamp). Deletion is a version with deleted: true.
 */
export async function putStrokes(strokes: StrokeRow[]) {
  if (!strokes.length) return
  await db.strokes.bulkPut(strokes.map((s) => ({ ...s, dirty: 1 as const })))
  changed()
}

export interface StrokeEventDetail {
  rows: StrokeRow[]
  source: 'local' | 'remote'
}

/** Stroke rows written by anything other than the open editor (sync, page duplication). */
export const strokeEvents = new EventTarget()

export function emitStrokes(rows: StrokeRow[], source: 'local' | 'remote') {
  if (rows.length) strokeEvents.dispatchEvent(new CustomEvent<StrokeEventDetail>('strokes', { detail: { rows, source } }))
}
