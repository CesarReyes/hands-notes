import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { Paper, PenStyle, StrokeRow, Template } from './types'

export const PAPER_COLORS: Record<Paper, { bg: string; line: string; margin: string }> = {
  white: { bg: '#ffffff', line: '#c9d3e0', margin: '#f0b4b4' },
  cream: { bg: '#fbf6e9', line: '#d6cbb0', margin: '#e8b7a5' },
  dark: { bg: '#23262d', line: '#3d424c', margin: '#6b4a4a' },
}

export function penStyleOf(tool: string): PenStyle | null {
  if (!tool.startsWith('pen')) return null
  return (tool.split(':')[1] as PenStyle) || 'ballpoint'
}

function optionsFor(tool: string, size: number, hasPressure: boolean): StrokeOptions {
  if (tool === 'highlighter') {
    return { size, thinning: 0, smoothing: 0.6, streamline: 0.55, simulatePressure: false, start: { cap: false }, end: { cap: false } }
  }
  const style = penStyleOf(tool)
  const base: StrokeOptions = { size, smoothing: 0.55, streamline: 0.4, simulatePressure: !hasPressure, last: true }
  switch (style) {
    case 'fountain':
      return { ...base, thinning: 0.65, start: { taper: size * 1.5, cap: true }, end: { taper: size * 2, cap: true } }
    case 'brush':
      return { ...base, thinning: 0.85, smoothing: 0.7, start: { taper: size * 3 }, end: { taper: size * 4 } }
    default:
      return { ...base, thinning: 0.2 }
  }
}

/** Whether the recorded pressures carry real stylus information (not a constant mouse/finger value). */
export function hasRealPressure(points: number[]): boolean {
  let first = -1
  for (let i = 2; i < points.length; i += 3) {
    if (first < 0) first = points[i]
    else if (Math.abs(points[i] - first) > 0.01) return true
  }
  return false
}

/** Outline polygon of a stroke in page coordinates: [[x, y], ...]. */
export function strokeOutline(tool: string, size: number, points: number[], complete = true): number[][] {
  const input: number[][] = []
  for (let i = 0; i < points.length; i += 3) input.push([points[i], points[i + 1], points[i + 2]])
  const opts = optionsFor(tool, size, hasRealPressure(points))
  return getStroke(input, { ...opts, last: complete })
}

export function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D()
  if (outline.length < 2) return path
  // Quadratic midpoints give smooth edges at any zoom.
  path.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1]
    const [x1, y1] = outline[i]
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  path.closePath()
  return path
}

const pathCache = new WeakMap<StrokeRow, Path2D>()

export function strokePath(s: StrokeRow): Path2D {
  let p = pathCache.get(s)
  if (!p) {
    p = outlineToPath(strokeOutline(s.tool, s.size, s.points))
    pathCache.set(s, p)
  }
  return p
}

export const HIGHLIGHTER_ALPHA = 0.35

/** Dark paper inverts pure black ink so notes stay readable. */
export function inkColor(color: string, paper: Paper): string {
  if (paper === 'dark' && (color === '#000000' || color === '#1a1a1a')) return '#f2f2f2'
  return color
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeRow, paper: Paper) {
  ctx.fillStyle = inkColor(s.color, paper)
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = HIGHLIGHTER_ALPHA
    ctx.fill(strokePath(s))
    ctx.globalAlpha = 1
  } else {
    ctx.fill(strokePath(s))
  }
}

/** Draws the paper background and ruling in page coordinates. */
export function drawPaper(ctx: CanvasRenderingContext2D, template: Template, paper: Paper, w: number, h: number) {
  const c = PAPER_COLORS[paper]
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = c.line
  ctx.fillStyle = c.line
  ctx.lineWidth = 1.2
  const top = 110
  const gap = 36
  switch (template) {
    case 'lined': {
      ctx.beginPath()
      for (let y = top; y < h - 40; y += gap) {
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
      }
      ctx.stroke()
      ctx.strokeStyle = c.margin
      ctx.beginPath()
      ctx.moveTo(110, 0)
      ctx.lineTo(110, h)
      ctx.stroke()
      break
    }
    case 'grid': {
      const g = 32
      ctx.lineWidth = 0.9
      ctx.beginPath()
      for (let x = g; x < w; x += g) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
      }
      for (let y = g; y < h; y += g) {
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
      }
      ctx.stroke()
      break
    }
    case 'dots': {
      const g = 32
      for (let x = g; x < w; x += g) {
        for (let y = g; y < h; y += g) {
          ctx.beginPath()
          ctx.arc(x, y, 1.7, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      break
    }
    case 'cornell': {
      ctx.beginPath()
      for (let y = top; y < h - 300; y += gap) {
        ctx.moveTo(280, y)
        ctx.lineTo(w, y)
      }
      ctx.stroke()
      ctx.strokeStyle = c.margin
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, top - gap)
      ctx.lineTo(w, top - gap)
      ctx.moveTo(250, top - gap)
      ctx.lineTo(250, h - 280)
      ctx.moveTo(0, h - 280)
      ctx.lineTo(w, h - 280)
      ctx.stroke()
      break
    }
    case 'blank':
      break
  }
}

/** Renders a whole page (paper + ink) into ctx, which must already be scaled to page units. */
export function drawPage(
  ctx: CanvasRenderingContext2D,
  page: { template: Template; paper: Paper; width: number; height: number },
  strokes: StrokeRow[],
) {
  drawPaper(ctx, page.template, page.paper, page.width, page.height)
  // Highlighter sits beneath pen ink, as on paper.
  for (const s of strokes) if (s.tool === 'highlighter') drawStroke(ctx, s, page.paper)
  for (const s of strokes) if (s.tool !== 'highlighter') drawStroke(ctx, s, page.paper)
}
