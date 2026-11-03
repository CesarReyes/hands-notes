import { describe, expect, it } from 'vitest'
import { decodePoints, encodePoints } from '../engine/encoding'
import { pointInPolygon, polylineHitsCircle, splitByCircle, straightLine, straightness, strokeInLasso, translatePoints } from '../engine/geometry'
import { History } from '../engine/history'
import { uuidv7 } from '../data/ids'
import { nextTimestamp, observeTimestamp } from '../data/clock'
import { fromWire, shouldApplyRemote, toWire } from '../data/wire'
import { parseBackground, pdfBackground } from '../engine/background'
import { imageFileId, imagePoints, imageRect, imageTool, isImage } from '../engine/images'
import type { PageRow, StrokeRow } from '../engine/types'

const line = (n: number, y = 0) => Array.from({ length: n }, (_, i) => [i * 10, y, 0.5]).flat()

function stroke(id: string, patch: Partial<StrokeRow> = {}): StrokeRow {
  return { id, notebook_id: 'nb', page_id: 'pg', tool: 'pen:ballpoint', color: '#000', size: 3, points: line(5), updated_at: 1, deleted: false, dirty: 0, ...patch }
}

describe('points encoding', () => {
  it('round-trips within 1/8 unit and keeps pressure', () => {
    const pts = [12.3456, 789.01, 0.42, -3.2, 1400.5, 1]
    const back = decodePoints(encodePoints(pts))
    expect(back).toHaveLength(6)
    back.forEach((v, i) => expect(Math.abs(v - pts[i])).toBeLessThan(i % 3 === 2 ? 1e-4 : 0.07))
  })
  it('is compact', () => {
    expect(encodePoints(line(300)).length).toBeLessThan(2500)
  })
  it('rejects unknown formats', () => {
    expect(() => decodePoints('x')).toThrow()
  })
})

describe('geometry', () => {
  it('detects circle hits on segments, not just vertices', () => {
    const pts = [0, 0, 0.5, 100, 0, 0.5]
    expect(polylineHitsCircle(pts, 50, 3, 4)).toBe(true)
    expect(polylineHitsCircle(pts, 50, 10, 4)).toBe(false)
  })
  it('partial erase splits a stroke into two runs', () => {
    const runs = splitByCircle(line(11), 50, 0, 6)!
    expect(runs).toHaveLength(2)
    expect(runs[0].at(-3)).toBe(40)
    expect(runs[1][0]).toBe(60)
  })
  it('partial erase returns null when untouched', () => {
    expect(splitByCircle(line(5), 500, 500, 5)).toBeNull()
  })
  it('lasso selects strokes mostly inside', () => {
    const square = [-10, -10, 200, -10, 200, 10, -10, 10]
    expect(pointInPolygon(5, 0, square)).toBe(true)
    expect(strokeInLasso(line(5), square)).toBe(true)
    expect(strokeInLasso(line(5, 50), square)).toBe(false)
  })
  it('translates points without touching pressure', () => {
    expect(translatePoints([1, 2, 0.3], 10, 20)).toEqual([11, 22, 0.3])
  })
  it('straightens a wobbly line between endpoints', () => {
    const wobbly = [0, 0, 0.5, 50, 4, 0.5, 100, 0, 0.5]
    expect(straightness(wobbly)).toBeGreaterThan(0.03)
    const s = straightLine(wobbly)
    expect(straightness(s)).toBeLessThan(1e-9)
    expect(s.slice(0, 2)).toEqual([0, 0])
    expect(s.slice(-3, -1)).toEqual([100, 0])
  })
})

describe('ids and clock', () => {
  it('uuidv7 ids sort by creation time', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7())
    expect([...ids].sort()).toEqual(ids)
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('timestamps are monotonic and beat observed remote clocks', () => {
    const a = nextTimestamp()
    expect(nextTimestamp()).toBeGreaterThan(a)
    observeTimestamp(Date.now() + 60_000)
    expect(nextTimestamp()).toBeGreaterThan(Date.now() + 59_000)
  })
})

describe('last-writer-wins merge', () => {
  it('applies remote rows over clean, older local rows', () => {
    expect(shouldApplyRemote(undefined, 5)).toBe(true)
    expect(shouldApplyRemote({ updated_at: 4, dirty: 0 }, 5)).toBe(true)
    expect(shouldApplyRemote({ updated_at: 6, dirty: 0 }, 5)).toBe(false)
  })
  it('keeps unpushed local edits unless remote is strictly newer', () => {
    expect(shouldApplyRemote({ updated_at: 5, dirty: 1 }, 5)).toBe(false)
    expect(shouldApplyRemote({ updated_at: 5, dirty: 1 }, 6)).toBe(true)
  })
  it('converts strokes to and from the wire format', () => {
    const s = stroke('a', { dirty: 1, updated_at: 123 })
    const wire = toWire('strokes', s)
    expect(wire).not.toHaveProperty('dirty')
    expect(typeof wire.points).toBe('string')
    const back = fromWire('strokes', { ...wire, user_id: 'u', server_ts: 'x', updated_at: '123' as unknown as number } as never) as StrokeRow
    expect(back).not.toHaveProperty('user_id')
    expect(back.updated_at).toBe(123)
    expect(back.dirty).toBe(0)
    back.points.forEach((v, i) => expect(v).toBeCloseTo(s.points[i], 4))
    // Re-encoding already-quantized points is lossless, so devices converge on identical ink.
    expect(decodePoints(encodePoints(back.points))).toEqual(back.points)
  })
})

describe('page backgrounds on the wire', () => {
  const fileId = uuidv7()
  const page = (patch: Partial<PageRow> = {}): PageRow => ({
    id: uuidv7(), notebook_id: 'nb', position: 1, template: 'blank', paper: 'white', width: 1000, height: 773,
    background: pdfBackground(fileId, 3), updated_at: 42, deleted: false, dirty: 1, ...patch,
  })

  it('formats and parses PDF background refs', () => {
    expect(parseBackground(pdfBackground(fileId, 3))).toEqual({ kind: 'pdf', fileId, page: 3 })
    expect(parseBackground(null)).toBeNull()
    expect(parseBackground('')).toBeNull()
    expect(parseBackground(`pdf:${fileId}:0`)).toBeNull()
    expect(parseBackground(`img:${fileId}:1`)).toBeNull()
    expect(parseBackground('pdf:not-a-uuid:1')).toBeNull()
  })
  it('sends the background with the page', () => {
    const p = page()
    const wire = toWire('pages', p)
    expect(wire).not.toHaveProperty('dirty')
    expect(wire.background).toBe(p.background)
    expect(wire.height).toBe(773)
  })
  it('sends an explicit null for pages stored before backgrounds existed', () => {
    const legacy = page()
    delete (legacy as Partial<PageRow>).background
    expect(toWire('pages', legacy)).toHaveProperty('background', null)
  })
  it('round-trips the background from the server', () => {
    const p = page()
    const back = fromWire('pages', { ...toWire('pages', p), user_id: 'u', server_ts: 'x', updated_at: '42' as unknown as number } as never) as PageRow
    expect(back).toEqual({ ...p, dirty: 0 })
  })
  it('treats a missing or empty server background as none', () => {
    const { background: _b, ...noColumn } = toWire('pages', page())
    expect((fromWire('pages', noColumn as never) as PageRow).background).toBeNull()
    expect((fromWire('pages', { ...noColumn, background: '' } as never) as PageRow).background).toBeNull()
  })
})

describe('placed images', () => {
  const fileId = '01a13f26-59f7-7305-a8cf-c24344b71e79'
  const img = stroke('img', { tool: imageTool(fileId), color: '', size: 0, points: imagePoints({ minX: 100, minY: 200.5, maxX: 640.25, maxY: 900 }) })

  it('is told apart from ink by its tool', () => {
    expect(isImage(img)).toBe(true)
    expect(imageFileId(img)).toBe(fileId)
    expect(isImage(stroke('ink'))).toBe(false)
    expect(imageFileId(stroke('ink'))).toBeNull()
  })

  it('keeps its rectangle through the wire format', () => {
    const back = fromWire('strokes', toWire('strokes', img) as never) as StrokeRow
    expect(back.tool).toBe(imageTool(fileId))
    expect(imageRect(back)).toEqual({ minX: 100, minY: 200.5, maxX: 640.25, maxY: 900 })
  })

  it('moves like ink', () => {
    expect(imageRect({ points: translatePoints(img.points, 10, -20) })).toEqual({ minX: 110, minY: 180.5, maxX: 650.25, maxY: 880 })
  })
})

describe('history', () => {
  it('undo returns before-states and redo after-states', () => {
    const h = new History()
    const before = stroke('a', { deleted: true })
    const after = stroke('a')
    h.push([{ before, after }])
    expect(h.undo()).toEqual([before])
    expect(h.canRedo).toBe(true)
    expect(h.redo()).toEqual([after])
    h.push([{ before: after, after: { ...after, color: '#f00' } }])
    expect(h.canRedo).toBe(false)
  })
})
