import type { Rect, StrokeRow } from './types'

/**
 * Images placed on a page. An image is a stroke row so it syncs, undoes, moves
 * and deletes like ink: `tool` is 'image:<fileId>' and `points` holds the two
 * corners [minX, minY, 0, maxX, maxY, 0] in page units. The bytes are a file row.
 */

const PREFIX = 'image:'
/** Longest edge kept on import; enough for a full-width page at 2x. */
const MAX_EDGE = 2048
const JPEG_QUALITY = 0.86
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function imageTool(fileId: string) {
  return PREFIX + fileId
}

export function imageFileId(s: Pick<StrokeRow, 'tool'>): string | null {
  return s.tool.startsWith(PREFIX) ? s.tool.slice(PREFIX.length) : null
}

export function isImage(s: Pick<StrokeRow, 'tool'>) {
  return s.tool.startsWith(PREFIX)
}

export function imageRect(s: Pick<StrokeRow, 'points'>): Rect {
  const [x0, y0, , x1, y1] = s.points
  return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) }
}

export function imagePoints(r: Rect): number[] {
  return [r.minX, r.minY, 0, r.maxX, r.maxY, 0]
}

// ---------------------------------------------------------------- decoding cache

/** Fired with detail = file id when its bitmap is ready (or failed to load). */
export const imageEvents = new EventTarget()

let loadImage: (fileId: string) => Promise<{ data: ArrayBuffer; type: string }> = () => Promise.reject(new Error('No image loader'))

export function setImageLoader(fn: typeof loadImage) {
  loadImage = fn
}

const decoded = new Map<string, ImageBitmap>()
const loading = new Set<string>()
const failedAt = new Map<string, number>()
const RETRY_MS = 15000

/** The decoded image, or null while it loads (a 'ready' event follows). */
export function imageBitmap(fileId: string): ImageBitmap | null {
  const bmp = decoded.get(fileId)
  if (bmp) return bmp
  const failed = failedAt.get(fileId)
  if (!loading.has(fileId) && (!failed || Date.now() - failed > RETRY_MS)) void decode(fileId)
  return null
}

async function decode(fileId: string) {
  loading.add(fileId)
  try {
    const { data, type } = await loadImage(fileId)
    decoded.set(fileId, await createImageBitmap(new Blob([data], { type })))
    failedAt.delete(fileId)
  } catch (e) {
    failedAt.set(fileId, Date.now())
    console.warn('Image unavailable', fileId, e)
  } finally {
    loading.delete(fileId)
    imageEvents.dispatchEvent(new CustomEvent('ready', { detail: fileId }))
  }
}

/** Seeds the cache with an image this device just imported, so it shows without a reload. */
export function rememberImage(fileId: string, bitmap: ImageBitmap) {
  decoded.set(fileId, bitmap)
}

// ---------------------------------------------------------------- import

export interface PreparedImage {
  data: ArrayBuffer
  type: string
  width: number
  height: number
  bitmap: ImageBitmap
}

/** Decodes a photo or screenshot, applies its EXIF rotation and scales it down for storage. */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const source = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  // PNG keeps screenshots and transparent images crisp; photos are far smaller as JPEG.
  const keepPng = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp'
  if (!keepPng) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(source, 0, 0, width, height)
  source.close()
  let type = keepPng ? 'image/png' : 'image/jpeg'
  let blob = await toBlob(canvas, type)
  if (keepPng && blob.size > MAX_IMAGE_BYTES / 2) {
    // A huge PNG (e.g. a photo saved as PNG): JPEG on white instead.
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    type = 'image/jpeg'
    blob = await toBlob(canvas, type)
  }
  const data = await blob.arrayBuffer()
  const bitmap = await createImageBitmap(canvas)
  canvas.width = canvas.height = 0
  return { data, type, width, height, bitmap }
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, JPEG_QUALITY),
  )
}
