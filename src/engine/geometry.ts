import type { Rect } from './types'

export function pointsBounds(points: number[], pad = 0): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** Squared distance from point p to segment ab. */
export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px, cy = ay + t * dy - py
  return cx * cx + cy * cy
}

/** True if the circle (cx, cy, r) touches the polyline. */
export function polylineHitsCircle(points: number[], cx: number, cy: number, r: number): boolean {
  const r2 = r * r
  if (points.length === 3) {
    const dx = points[0] - cx, dy = points[1] - cy
    return dx * dx + dy * dy <= r2
  }
  for (let i = 0; i + 5 < points.length; i += 3) {
    if (distToSegmentSq(cx, cy, points[i], points[i + 1], points[i + 3], points[i + 4]) <= r2) return true
  }
  return false
}

/**
 * Partial erase: remove the parts of a polyline within radius r of (cx, cy).
 * Returns the surviving runs (each a flat point array with >= 1 point).
 * Returns null when nothing was erased.
 */
export function splitByCircle(points: number[], cx: number, cy: number, r: number): number[][] | null {
  const r2 = r * r
  const runs: number[][] = []
  let current: number[] = []
  let erased = false
  for (let i = 0; i < points.length; i += 3) {
    const dx = points[i] - cx, dy = points[i + 1] - cy
    if (dx * dx + dy * dy <= r2) {
      erased = true
      if (current.length) runs.push(current)
      current = []
    } else {
      current.push(points[i], points[i + 1], points[i + 2])
    }
  }
  if (current.length) runs.push(current)
  if (!erased) {
    // Points can straddle the eraser with the segment crossing it; split there too.
    for (let i = 0; i + 5 < points.length; i += 3) {
      if (distToSegmentSq(cx, cy, points[i], points[i + 1], points[i + 3], points[i + 4]) <= r2) {
        return [points.slice(0, i + 3), points.slice(i + 3)]
      }
    }
    return null
  }
  return runs
}

/** Ray-casting point-in-polygon; polygon is flat [x, y, x, y, ...]. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1]
    const xj = poly[j * 2], yj = poly[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A stroke is lasso-selected when most of its points fall inside the lasso. */
export function strokeInLasso(points: number[], poly: number[], threshold = 0.5): boolean {
  if (poly.length < 6) return false
  let inside = 0, total = 0
  for (let i = 0; i < points.length; i += 3) {
    total++
    if (pointInPolygon(points[i], points[i + 1], poly)) inside++
  }
  return total > 0 && inside / total >= threshold
}

export function translatePoints(points: number[], dx: number, dy: number): number[] {
  const out = points.slice()
  for (let i = 0; i < out.length; i += 3) {
    out[i] += dx
    out[i + 1] += dy
  }
  return out
}

/** Linear interpolate a straight line between the first and last point (for hold-to-straighten). */
export function straightLine(points: number[]): number[] {
  const n = points.length / 3
  if (n < 2) return points
  const x0 = points[0], y0 = points[1]
  const x1 = points[points.length - 3], y1 = points[points.length - 2]
  const len = Math.hypot(x1 - x0, y1 - y0)
  const steps = Math.max(2, Math.ceil(len / 4))
  let pAvg = 0
  for (let i = 2; i < points.length; i += 3) pAvg += points[i]
  pAvg /= n
  const out: number[] = []
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, pAvg)
  }
  return out
}

/** Max distance of the polyline from the chord between its endpoints, relative to chord length. */
export function straightness(points: number[]): number {
  const n = points.length / 3
  if (n < 3) return 0
  const x0 = points[0], y0 = points[1]
  const x1 = points[points.length - 3], y1 = points[points.length - 2]
  const len = Math.hypot(x1 - x0, y1 - y0)
  if (len < 1) return Infinity
  let max = 0
  for (let i = 0; i < points.length; i += 3) {
    max = Math.max(max, Math.sqrt(distToSegmentSq(points[i], points[i + 1], x0, y0, x1, y1)))
  }
  return max / len
}
