import type { PDFDocumentProxy } from 'pdfjs-dist'
import { parseBackground } from './background'
import { openPdf } from './pdfjs'

/**
 * Renders PDF page backgrounds into bitmaps for the page cache and thumbnails.
 * Lookups are synchronous: a caller gets the best bitmap available now, and a
 * sharper one is rendered in the background, announced through `backgroundEvents`.
 */

/** Fired with detail = background ref when a new bitmap for it is ready. */
export const backgroundEvents = new EventTarget()

let loadFile: (fileId: string) => Promise<ArrayBuffer> = () => Promise.reject(new Error('No file loader'))

export function setFileLoader(fn: (fileId: string) => Promise<ArrayBuffer>) {
  loadFile = fn
}

interface Rendered {
  ref: string
  width: number
  canvas: HTMLCanvasElement
}

const docs = new Map<string, Promise<PDFDocumentProxy>>()
/** Most recently used last. */
let rendered: Rendered[] = []
const pending = new Set<string>()
const failedAt = new Map<string, number>()
const RETRY_MS = 15000
const MAX_RENDERED = 12
const MAX_RENDERED_PIXELS = 40_000_000

function doc(fileId: string): Promise<PDFDocumentProxy> {
  let d = docs.get(fileId)
  if (!d) {
    d = loadFile(fileId).then(openPdf)
    d.catch(() => docs.delete(fileId))
    docs.set(fileId, d)
  }
  return d
}

/** Widths snap to 256 px steps so small zoom changes reuse the same bitmap. */
function bucket(px: number) {
  return Math.max(256, Math.ceil(px / 256) * 256)
}

/**
 * Best bitmap for `ref` at about `pxWidth` pixels wide, or null if none is ready
 * yet. Requests a render at that width when no exact match exists.
 */
export function backgroundImage(ref: string | null | undefined, pxWidth: number): HTMLCanvasElement | null {
  const bg = ref ? parseBackground(ref) : null
  if (!bg || !ref) return null
  const width = bucket(pxWidth)
  const mine = rendered.filter((r) => r.ref === ref)
  const exact = mine.find((r) => r.width === width)
  if (exact) {
    rendered = [...rendered.filter((r) => r !== exact), exact]
    return exact.canvas
  }
  const failed = failedAt.get(bg.fileId)
  if (!failed || Date.now() - failed > RETRY_MS) void render(ref, bg.fileId, bg.page, width)
  // Meanwhile, the sharpest bitmap we have (scaled by drawImage).
  return mine.reduce<Rendered | null>((best, r) => (!best || r.width > best.width ? r : best), null)?.canvas ?? null
}

async function render(ref: string, fileId: string, pageNumber: number, width: number) {
  const key = `${ref}@${width}`
  if (pending.has(key)) return
  pending.add(key)
  try {
    const pdf = await doc(fileId)
    const page = await pdf.getPage(Math.min(pageNumber, pdf.numPages))
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.round(viewport.height)
    await page.render({ canvas, viewport }).promise
    failedAt.delete(fileId)
    rendered = [...rendered.filter((r) => !(r.ref === ref && r.width === width)), { ref, width, canvas }]
    evict()
    backgroundEvents.dispatchEvent(new CustomEvent('ready', { detail: ref }))
  } catch (e) {
    failedAt.set(fileId, Date.now())
    console.warn('PDF background unavailable', ref, e)
  } finally {
    pending.delete(key)
  }
}

function evict() {
  let pixels = rendered.reduce((n, r) => n + r.canvas.width * r.canvas.height, 0)
  while (rendered.length > 1 && (rendered.length > MAX_RENDERED || pixels > MAX_RENDERED_PIXELS)) {
    const old = rendered.shift()!
    pixels -= old.canvas.width * old.canvas.height
    old.canvas.width = old.canvas.height = 0 // release the bitmap memory now (Safari is slow to GC canvases)
  }
}

/** A file just arrived locally (e.g. downloaded by sync): retry its pages right away. */
export function fileAvailable(fileId: string) {
  if (!failedAt.delete(fileId)) return
  backgroundEvents.dispatchEvent(new CustomEvent('ready', { detail: null }))
}
