import { useEffect, useRef, useState } from 'react'
import { backgroundEvents, backgroundImage } from '../engine/pdfBackgrounds'
import { imageEvents, imageFileId } from '../engine/images'
import { drawPage } from '../engine/render'
import type { PageRow, StrokeRow } from '../engine/types'

/** Small rendering of a page; redraws whenever its strokes, background or image bitmaps change. */
export function PageThumb({ page, strokes, width }: { page: PageRow; strokes: StrokeRow[]; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const height = Math.round((width * page.height) / page.width)
  const [bgVersion, setBgVersion] = useState(0)
  useEffect(() => {
    if (!page.background) return
    const onReady = (e: Event) => {
      const r = (e as CustomEvent<string | null>).detail
      if (r === null || r === page.background) setBgVersion((v) => v + 1)
    }
    backgroundEvents.addEventListener('ready', onReady)
    return () => backgroundEvents.removeEventListener('ready', onReady)
  }, [page.background])
  const imageIds = strokes.flatMap((s) => imageFileId(s) ?? []).join(',')
  useEffect(() => {
    if (!imageIds) return
    const ids = new Set(imageIds.split(','))
    const onReady = (e: Event) => ids.has((e as CustomEvent<string>).detail) && setBgVersion((v) => v + 1)
    imageEvents.addEventListener('ready', onReady)
    return () => imageEvents.removeEventListener('ready', onReady)
  }, [imageIds])
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    c.width = Math.round(width * dpr)
    c.height = Math.round(height * dpr)
    const ctx = c.getContext('2d')!
    const k = (width * dpr) / page.width
    ctx.setTransform(k, 0, 0, k, 0, 0)
    const sorted = strokes.slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    drawPage(ctx, page, sorted, backgroundImage(page.background, c.width))
  }, [page, strokes, width, height, bgVersion])
  return <canvas ref={ref} className="thumb" style={{ width, height }} />
}
