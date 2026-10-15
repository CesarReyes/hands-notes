import { useEffect, useRef } from 'react'
import { drawPage } from '../engine/render'
import type { PageRow, StrokeRow } from '../engine/types'

/** Small rendering of a page; redraws whenever its strokes change. */
export function PageThumb({ page, strokes, width }: { page: PageRow; strokes: StrokeRow[]; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const height = Math.round((width * page.height) / page.width)
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
    drawPage(ctx, page, sorted)
  }, [page, strokes, width, height])
  return <canvas ref={ref} className="thumb" style={{ width, height }} />
}
