import { nextTimestamp } from '../data/clock'
import { uuidv7 } from '../data/ids'
import {
  pointsBounds,
  polylineHitsCircle,
  rectsIntersect,
  splitByCircle,
  straightLine,
  strokeInLasso,
  translatePoints,
  unionRect,
} from './geometry'
import { History, type StrokeChange } from './history'
import { backgroundEvents, backgroundImage } from './pdfBackgrounds'
import { drawPage, drawStroke, HIGHLIGHTER_ALPHA, inkColor, outlineToPath, strokeOutline } from './render'
import type { PageRow, PenStyle, Rect, StrokeRow, Tool } from './types'

export interface EditorSettings {
  tool: Tool
  penStyle: PenStyle
  penColor: string
  highlighterColor: string
  penSize: number
  highlighterSize: number
  /** Eraser radius in screen pixels, so it feels the same at any zoom. */
  eraserSize: number
  eraserMode: 'stroke' | 'partial'
  /** Fingers only scroll and zoom; only the stylus writes (palm rejection). */
  stylusOnly: boolean
  holdToStraighten: boolean
}

export interface SelectionInfo {
  count: number
  /** Selection bounds in container (CSS px) coordinates. */
  screenRect: { x: number; y: number; width: number; height: number }
}

export interface EditorCallbacks {
  /** Persist stroke versions (already timestamped). */
  onCommit(rows: StrokeRow[]): void
  onHistory(state: { canUndo: boolean; canRedo: boolean }): void
  onView(state: { pageIndex: number; zoom: number; fitZoom: number }): void
  onSelection(info: SelectionInfo | null): void
  /** Fired when a stylus is first seen, so the UI can enable stylus-only mode. */
  onStylusDetected?(): void
}

interface LayoutPage {
  page: PageRow
  y: number
}

interface Gesture {
  startDist: number
  startZoom: number
  startMid: { x: number; y: number }
  startCam: { x: number; y: number }
  startTime: number
  moved: boolean
  maxTouches: number
  last: { x: number; y: number; t: number }
  vx: number
  vy: number
}

interface CacheEntry {
  canvas: HTMLCanvasElement
  scale: number
  valid: boolean
}

type Action =
  | { kind: 'ink'; pointerId: number; pageId: string; points: number[]; predicted: number[]; tool: string; color: string; size: number; snapped: boolean }
  | { kind: 'erase'; pointerId: number; pageId: string; removed: Map<string, StrokeRow>; added: StrokeRow[]; last: { x: number; y: number } | null }
  | { kind: 'lasso'; pointerId: number; pageId: string; poly: number[] }
  | { kind: 'move'; pointerId: number; pageId: string; start: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'pan'; pointerId: number; last: { x: number; y: number }; vx: number; vy: number; t: number }

const PAGE_GAP = 28
const MARGIN = 16
/** Upper bound on cached page bitmap size; above this we draw directly (deep zoom). */
const MAX_CACHE_PIXELS = 6_500_000
const MAX_CACHED_PAGES = 4
const HOLD_MS = 550
const TAP_MS = 260

export class Editor {
  private base: HTMLCanvasElement
  private live: HTMLCanvasElement
  private bctx: CanvasRenderingContext2D
  private lctx: CanvasRenderingContext2D
  private dpr = 1
  private width = 0
  private height = 0

  private pages: LayoutPage[] = []
  private docHeight = 0
  private strokes = new Map<string, StrokeRow[]>() // pageId → strokes sorted by id
  private byId = new Map<string, StrokeRow>()
  private cache = new Map<string, CacheEntry>()

  private zoom = 1
  private fitZoom = 1
  private camX = 0
  private camY = 0
  private zoomInitialized = false

  private settings: EditorSettings
  private history = new History()
  private action: Action | null = null
  private touches = new Map<number, { x: number; y: number }>()
  private gesture: Gesture | null = null
  private stylusSeen = false
  private actionPointerType = ''
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private interacting = false
  private momentum: number | null = null

  private selection: { pageId: string; ids: Set<string> } | null = null
  private hidden = new Set<string>() // strokes drawn on the live layer instead of the base
  private frame = 0
  private needsBase = true
  private needsLive = true
  private resizeObserver: ResizeObserver
  private disposed = false

  constructor(
    private container: HTMLElement,
    settings: EditorSettings,
    private cb: EditorCallbacks,
  ) {
    this.settings = settings
    this.base = document.createElement('canvas')
    this.live = document.createElement('canvas')
    for (const c of [this.base, this.live]) {
      c.style.position = 'absolute'
      c.style.inset = '0'
      c.style.width = '100%'
      c.style.height = '100%'
      container.appendChild(c)
    }
    this.live.style.pointerEvents = 'none'
    this.bctx = this.base.getContext('2d', { alpha: false })!
    // No `desynchronized` here: on many Android GPUs Chrome promotes such a canvas to an
    // overlay plane without alpha blending, so this transparent layer turns black and hides
    // the pages. Latency comes from coalesced and predicted pointer events instead.
    this.lctx = this.live.getContext('2d')!

    container.style.touchAction = 'none'
    container.addEventListener('pointerdown', this.onPointerDown)
    container.addEventListener('pointermove', this.onPointerMove)
    container.addEventListener('pointerup', this.onPointerUp)
    container.addEventListener('pointercancel', this.onPointerCancel)
    container.addEventListener('wheel', this.onWheel, { passive: false })
    container.addEventListener('contextmenu', (e) => e.preventDefault())
    // iOS Safari still fires legacy touch gestures; block them so the page never zooms or scrolls.
    container.addEventListener('touchstart', preventDefault, { passive: false })
    container.addEventListener('touchmove', preventDefault, { passive: false })
    container.addEventListener('gesturestart', preventDefault as EventListener)

    backgroundEvents.addEventListener('ready', this.onBackgroundReady)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    if (this.momentum) cancelAnimationFrame(this.momentum)
    this.resizeObserver.disconnect()
    backgroundEvents.removeEventListener('ready', this.onBackgroundReady)
    this.container.removeEventListener('pointerdown', this.onPointerDown)
    this.container.removeEventListener('pointermove', this.onPointerMove)
    this.container.removeEventListener('pointerup', this.onPointerUp)
    this.container.removeEventListener('pointercancel', this.onPointerCancel)
    this.container.removeEventListener('wheel', this.onWheel)
    this.container.removeEventListener('touchstart', preventDefault)
    this.container.removeEventListener('touchmove', preventDefault)
    this.base.remove()
    this.live.remove()
    this.cache.clear()
  }

  // ---------------------------------------------------------------- data

  setSettings(settings: EditorSettings) {
    const toolChanged = settings.tool !== this.settings.tool
    this.settings = settings
    if (toolChanged && settings.tool !== 'lasso') this.clearSelection()
    this.needsLive = true
    this.schedule()
  }

  setPages(pages: PageRow[]) {
    const prev = new Map(this.pages.map((p) => [p.page.id, p.page]))
    let y = 0
    this.pages = pages.map((page) => {
      const lp = { page, y }
      y += page.height + PAGE_GAP
      const old = prev.get(page.id)
      if (old && (old.template !== page.template || old.paper !== page.paper || old.background !== page.background)) this.invalidate(page.id)
      return lp
    })
    this.docHeight = Math.max(0, y - PAGE_GAP)
    if (!this.zoomInitialized && this.width > 0) this.initZoom()
    this.clampCamera()
    this.requestBase()
    this.emitView()
  }

  setStrokes(rows: StrokeRow[]) {
    this.strokes.clear()
    this.byId.clear()
    for (const s of rows) if (!s.deleted) this.insert(s)
    for (const list of this.strokes.values()) list.sort(byId)
    this.cache.forEach((c) => (c.valid = false))
    this.requestBase()
  }

  /** Merge stroke versions written elsewhere (other devices, page duplication). */
  applyExternal(rows: StrokeRow[]) {
    const touched = new Set<string>()
    for (const s of rows) {
      const cur = this.byId.get(s.id)
      if (cur && cur.updated_at >= s.updated_at) continue
      if (cur) this.remove(cur)
      if (!s.deleted) this.insert(s, true)
      touched.add(s.page_id)
      if (cur) touched.add(cur.page_id)
      if (this.selection?.ids.has(s.id)) this.clearSelection()
    }
    touched.forEach((id) => this.invalidate(id))
    if (touched.size) this.requestBase()
  }

  private insert(s: StrokeRow, sorted = false) {
    this.byId.set(s.id, s)
    let list = this.strokes.get(s.page_id)
    if (!list) this.strokes.set(s.page_id, (list = []))
    if (!sorted) {
      list.push(s)
      return
    }
    // Keep creation order (UUIDv7 ids are time-ordered).
    let i = list.length
    while (i > 0 && list[i - 1].id > s.id) i--
    list.splice(i, 0, s)
  }

  private remove(s: StrokeRow) {
    this.byId.delete(s.id)
    const list = this.strokes.get(s.page_id)
    if (!list) return
    const i = list.indexOf(s)
    if (i >= 0) list.splice(i, 1)
  }

  /** Apply versions created by this editor: update memory, persist, and optionally record undo. */
  private commit(changes: StrokeChange[], record = true) {
    if (!changes.length) return
    const pagesTouched = new Set<string>()
    let incremental = true
    for (const { before, after } of changes) {
      const cur = this.byId.get(after.id)
      if (cur) {
        this.remove(cur)
        pagesTouched.add(cur.page_id)
        incremental = false
      }
      if (!after.deleted) this.insert(after, true)
      pagesTouched.add(after.page_id)
      if (after.tool === 'highlighter' || !before.deleted) incremental = false
    }
    // Fast path: a single new pen stroke is painted onto the cached bitmap instead of re-rendering the page.
    if (incremental && changes.length === 1) {
      const s = changes[0].after
      const entry = this.cache.get(s.page_id)
      const page = this.pageById(s.page_id)
      if (entry?.valid && page) {
        const ctx = entry.canvas.getContext('2d')!
        ctx.setTransform(entry.scale, 0, 0, entry.scale, 0, 0)
        drawStroke(ctx, s, page.paper)
      } else this.invalidate(s.page_id)
    } else pagesTouched.forEach((id) => this.invalidate(id))
    if (record) {
      this.history.push(changes)
      this.emitHistory()
    }
    this.cb.onCommit(changes.map((c) => c.after))
    this.requestBase()
  }

  undo() {
    this.clearSelection()
    const rows = this.history.undo()
    if (rows) this.restore(rows)
    this.emitHistory()
  }

  redo() {
    this.clearSelection()
    const rows = this.history.redo()
    if (rows) this.restore(rows)
    this.emitHistory()
  }

  private restore(states: StrokeRow[]) {
    const changes: StrokeChange[] = states.map((s) => {
      const cur = this.byId.get(s.id)
      const before = cur ?? { ...s, deleted: true }
      return { before, after: { ...s, updated_at: nextTimestamp() } }
    })
    this.commit(changes, false)
  }

  private emitHistory() {
    this.cb.onHistory({ canUndo: this.history.canUndo, canRedo: this.history.canRedo })
  }

  // ---------------------------------------------------------------- selection actions

  deleteSelection() {
    if (!this.selection) return
    const changes = [...this.selection.ids].flatMap((id) => {
      const s = this.byId.get(id)
      return s ? [{ before: s, after: { ...s, deleted: true, updated_at: nextTimestamp() } }] : []
    })
    this.clearSelection()
    this.commit(changes)
  }

  recolorSelection(color: string) {
    if (!this.selection) return
    const changes = [...this.selection.ids].flatMap((id) => {
      const s = this.byId.get(id)
      return s ? [{ before: s, after: { ...s, color, updated_at: nextTimestamp() } }] : []
    })
    this.commit(changes)
    this.emitSelection()
  }

  duplicateSelection() {
    if (!this.selection) return
    const offset = 24
    const created: StrokeRow[] = []
    const changes = [...this.selection.ids].flatMap((id) => {
      const s = this.byId.get(id)
      if (!s) return []
      const copy: StrokeRow = { ...s, id: uuidv7(), points: translatePoints(s.points, offset, offset), updated_at: nextTimestamp() }
      created.push(copy)
      return [{ before: { ...copy, deleted: true }, after: copy }]
    })
    this.commit(changes)
    this.selection = { pageId: this.selection.pageId, ids: new Set(created.map((s) => s.id)) }
    this.emitSelection()
    this.needsLive = true
    this.schedule()
  }

  clearSelection() {
    if (!this.selection) return
    this.selection = null
    this.cb.onSelection(null)
    this.needsLive = true
    this.schedule()
  }

  private selectionBounds(): Rect | null {
    if (!this.selection) return null
    let r: Rect | null = null
    for (const id of this.selection.ids) {
      const s = this.byId.get(id)
      if (s) r = unionRect(r, pointsBounds(s.points, s.size))
    }
    return r
  }

  private emitSelection() {
    const r = this.selectionBounds()
    const lp = this.selection && this.layoutOf(this.selection.pageId)
    if (!r || !lp) return this.cb.onSelection(null)
    const dx = this.action?.kind === 'move' ? this.action.dx : 0
    const dy = this.action?.kind === 'move' ? this.action.dy : 0
    const a = this.toScreen(lp, r.minX + dx, r.minY + dy)
    const b = this.toScreen(lp, r.maxX + dx, r.maxY + dy)
    this.cb.onSelection({ count: this.selection!.ids.size, screenRect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y } })
  }

  // ---------------------------------------------------------------- camera

  private initZoom() {
    this.zoomInitialized = true
    this.fitZoom = this.computeFit()
    this.zoom = this.fitZoom
    this.camY = -MARGIN
    this.clampCamera()
  }

  private computeFit() {
    const pageW = this.pages[0]?.page.width ?? 1000
    return Math.max(0.1, (this.width - MARGIN * 2) / pageW)
  }

  get pageWidth() {
    return this.pages[0]?.page.width ?? 1000
  }

  private clampCamera() {
    const docW = this.pageWidth * this.zoom
    if (docW + MARGIN * 2 <= this.width) this.camX = -(this.width - docW) / 2
    else this.camX = Math.min(Math.max(this.camX, -MARGIN), docW - this.width + MARGIN)
    const docH = this.docHeight * this.zoom
    const minY = -MARGIN
    const maxY = Math.max(minY, docH - this.height + MARGIN * 4)
    this.camY = Math.min(Math.max(this.camY, minY), maxY)
  }

  private zoomAt(newZoom: number, sx: number, sy: number) {
    const z = Math.min(Math.max(newZoom, this.fitZoom * 0.5), this.fitZoom * 8)
    const docX = (sx + this.camX) / this.zoom
    const docY = (sy + this.camY) / this.zoom
    this.zoom = z
    this.camX = docX * z - sx
    this.camY = docY * z - sy
    this.clampCamera()
  }

  scrollToPage(index: number) {
    const lp = this.pages[index]
    if (!lp) return
    this.camY = lp.y * this.zoom - MARGIN
    this.clampCamera()
    this.requestBase()
    this.emitView()
  }

  resetZoom() {
    const centerDocY = (this.camY + this.height / 2) / this.zoom
    this.zoom = this.fitZoom
    this.camY = centerDocY * this.zoom - this.height / 2
    this.clampCamera()
    this.settle()
  }

  private emitView() {
    const mid = (this.camY + this.height / 3) / this.zoom
    let pageIndex = 0
    for (let i = 0; i < this.pages.length; i++) if (this.pages[i].y <= mid) pageIndex = i
    this.cb.onView({ pageIndex, zoom: this.zoom, fitZoom: this.fitZoom })
  }

  private resize() {
    const rect = this.container.getBoundingClientRect()
    this.dpr = Math.min(window.devicePixelRatio || 1, 3)
    this.width = rect.width
    this.height = rect.height
    for (const c of [this.base, this.live]) {
      c.width = Math.round(rect.width * this.dpr)
      c.height = Math.round(rect.height * this.dpr)
    }
    if (this.pages.length) {
      const oldFit = this.fitZoom
      this.fitZoom = this.computeFit()
      if (!this.zoomInitialized) this.initZoom()
      else if (Math.abs(this.zoom - oldFit) < 0.001) this.zoom = this.fitZoom // stay fit-to-width across rotation
      this.clampCamera()
    }
    this.cache.forEach((c) => (c.valid = false))
    this.needsBase = this.needsLive = true
    this.renderNow()
    this.emitView()
  }

  // ---------------------------------------------------------------- coordinates

  private layoutOf(pageId: string): LayoutPage | undefined {
    return this.pages.find((p) => p.page.id === pageId)
  }

  private pageById(pageId: string): PageRow | undefined {
    return this.layoutOf(pageId)?.page
  }

  private toScreen(lp: LayoutPage, x: number, y: number) {
    return { x: x * this.zoom - this.camX, y: (lp.y + y) * this.zoom - this.camY }
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.container.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private toPage(lp: LayoutPage, sx: number, sy: number) {
    return { x: (sx + this.camX) / this.zoom, y: (sy + this.camY) / this.zoom - lp.y }
  }

  /** Page under a screen point; points in the gap snap to the nearest page. */
  private pageAt(sy: number): LayoutPage | undefined {
    const docY = (sy + this.camY) / this.zoom
    let best: LayoutPage | undefined
    let bestDist = Infinity
    for (const lp of this.pages) {
      const d = docY < lp.y ? lp.y - docY : docY > lp.y + lp.page.height ? docY - lp.y - lp.page.height : 0
      if (d < bestDist) {
        bestDist = d
        best = lp
      }
    }
    return bestDist <= PAGE_GAP ? best : undefined
  }

  // ---------------------------------------------------------------- input

  /** Capture can fail for pointers that already ended (or synthetic ones); drawing still works without it. */
  private capture(pointerId: number) {
    try {
      this.container.setPointerCapture(pointerId)
    } catch {
      /* ignore */
    }
  }

  private isDrawingPointer(e: PointerEvent) {
    if (e.pointerType === 'pen') return true
    if (e.pointerType === 'mouse') return e.button === 0
    return !this.settings.stylusOnly
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.disposed) return
    e.preventDefault()
    this.stopMomentum()
    const p = this.local(e)

    if (e.pointerType === 'pen' && !this.stylusSeen) {
      this.stylusSeen = true
      this.cb.onStylusDetected?.()
    }

    if (e.pointerType === 'pen' && this.gesture) {
      // A palm resting before the pen landed started a pan; the pen wins.
      this.gesture = null
      this.touches.clear()
    }

    if (e.pointerType === 'touch') {
      // Palm rejection: while the stylus (or mouse) is writing, ignore every touch.
      if (this.action && this.action.kind !== 'pan' && this.actionPointerType !== 'touch') return
      this.touches.set(e.pointerId, p)
      if (this.touches.size >= 2 || this.settings.stylusOnly) {
        if (this.action?.kind === 'ink' || this.action?.kind === 'pan') this.cancelAction()
        this.beginGesture()
        return
      }
    }

    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
      this.capture(e.pointerId)
      this.action = { kind: 'pan', pointerId: e.pointerId, last: p, vx: 0, vy: 0, t: e.timeStamp }
      return
    }

    if (!this.isDrawingPointer(e) || this.action) return
    const lp = this.pageAt(p.y)
    if (!lp) return
    this.capture(e.pointerId)
    this.actionPointerType = e.pointerType
    const pt = this.toPage(lp, p.x, p.y)
    // Barrel / eraser-end buttons on S Pen, Surface and Wacom pens erase.
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0)
    const tool = penEraser ? 'eraser' : this.settings.tool
    this.interacting = true

    if (tool === 'lasso') {
      const bounds = this.selectionBounds()
      if (this.selection && this.selection.pageId === lp.page.id && bounds && inside(bounds, pt.x, pt.y, 12 / this.zoom)) {
        this.action = { kind: 'move', pointerId: e.pointerId, pageId: lp.page.id, start: pt, dx: 0, dy: 0 }
        this.selection.ids.forEach((id) => this.hidden.add(id))
        this.invalidate(lp.page.id)
        this.requestBase()
      } else {
        this.clearSelection()
        this.action = { kind: 'lasso', pointerId: e.pointerId, pageId: lp.page.id, poly: [pt.x, pt.y] }
      }
    } else if (tool === 'eraser') {
      this.action = { kind: 'erase', pointerId: e.pointerId, pageId: lp.page.id, removed: new Map(), added: [], last: null }
      this.eraseAt(lp, pt.x, pt.y)
    } else {
      const s = this.settings
      const isHl = tool === 'highlighter'
      this.action = {
        kind: 'ink',
        pointerId: e.pointerId,
        pageId: lp.page.id,
        points: [pt.x, pt.y, pressureOf(e)],
        predicted: [],
        tool: isHl ? 'highlighter' : `pen:${s.penStyle}`,
        color: isHl ? s.highlighterColor : s.penColor,
        size: isHl ? s.highlighterSize : s.penSize,
        snapped: false,
      }
      this.armHold()
    }
    this.needsLive = true
    this.schedule()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.disposed) return
    const p = this.local(e)
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p)
      if (this.gesture) {
        this.updateGesture()
        return
      }
    }
    const a = this.action
    if (!a || a.pointerId !== e.pointerId) {
      if (!a && this.settings.tool === 'eraser' && e.pointerType !== 'touch') this.drawHover(p)
      return
    }
    if (a.kind === 'pan') {
      const dt = Math.max(1, e.timeStamp - a.t)
      const dx = p.x - a.last.x, dy = p.y - a.last.y
      a.vx = (dx / dt) * 0.8 + a.vx * 0.2
      a.vy = (dy / dt) * 0.8 + a.vy * 0.2
      a.last = p
      a.t = e.timeStamp
      this.camX -= dx
      this.camY -= dy
      this.clampCamera()
      this.requestBase()
      this.emitView()
      return
    }
    const lp = this.layoutOf(a.pageId)
    if (!lp) return
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const samples = events.length ? events : [e]

    if (a.kind === 'ink') {
      if (a.snapped) {
        const pt = this.toPage(lp, p.x, p.y)
        a.points = straightLine([a.points[0], a.points[1], a.points[2], pt.x, pt.y, a.points[2]])
      } else {
        for (const ev of samples) {
          const q = this.local(ev)
          const pt = this.toPage(lp, q.x, q.y)
          const n = a.points.length
          // Skip sub-pixel jitter; it only adds noise to the outline.
          if (Math.hypot(pt.x - a.points[n - 3], pt.y - a.points[n - 2]) * this.zoom < 0.4) continue
          a.points.push(pt.x, pt.y, pressureOf(ev))
          this.armHold()
        }
        a.predicted = []
        const predicted = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : []
        for (const ev of predicted.slice(0, 2)) {
          const q = this.local(ev)
          const pt = this.toPage(lp, q.x, q.y)
          a.predicted.push(pt.x, pt.y, pressureOf(ev))
        }
      }
    } else if (a.kind === 'erase') {
      for (const ev of samples) {
        const q = this.local(ev)
        const pt = this.toPage(lp, q.x, q.y)
        this.eraseAt(lp, pt.x, pt.y)
      }
    } else if (a.kind === 'lasso') {
      for (const ev of samples) {
        const q = this.local(ev)
        const pt = this.toPage(lp, q.x, q.y)
        a.poly.push(pt.x, pt.y)
      }
    } else if (a.kind === 'move') {
      const pt = this.toPage(lp, p.x, p.y)
      a.dx = pt.x - a.start.x
      a.dy = pt.y - a.start.y
      this.emitSelection()
    }
    this.needsLive = true
    this.schedule()
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.disposed) return
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId)
      if (this.gesture) {
        if (this.touches.size === 0) this.endGesture()
        else this.beginGesture(true)
        return
      }
    }
    const a = this.action
    if (!a || a.pointerId !== e.pointerId) return
    this.clearHold()
    this.action = null
    this.interacting = false
    if (a.kind === 'pan') {
      this.startMomentum(a.vx, a.vy)
    } else if (a.kind === 'ink') {
      this.finishInk(a)
    } else if (a.kind === 'erase') {
      const changes: StrokeChange[] = [
        ...[...a.removed.values()].map((s) => ({ before: s, after: { ...s, deleted: true, updated_at: nextTimestamp() } })),
        ...a.added.map((s) => ({ before: { ...s, deleted: true }, after: { ...s, updated_at: nextTimestamp() } })),
      ]
      a.removed.forEach((s) => this.hidden.delete(s.id))
      this.commit(changes)
    } else if (a.kind === 'lasso') {
      this.finishLasso(a)
    } else if (a.kind === 'move') {
      this.selection?.ids.forEach((id) => this.hidden.delete(id))
      if (Math.abs(a.dx) > 0.5 || Math.abs(a.dy) > 0.5) {
        const changes = [...(this.selection?.ids ?? [])].flatMap((id) => {
          const s = this.byId.get(id)
          return s ? [{ before: s, after: { ...s, points: quantize(translatePoints(s.points, a.dx, a.dy)), updated_at: nextTimestamp() } }] : []
        })
        this.commit(changes)
      } else {
        this.invalidate(a.pageId)
        this.requestBase()
      }
      this.emitSelection()
    }
    this.needsLive = true
    this.settle()
  }

  private onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId)
      if (this.gesture && this.touches.size === 0) {
        this.gesture = null
        this.settle()
      }
    }
    if (this.action?.pointerId === e.pointerId) this.cancelAction()
  }

  private cancelAction() {
    const a = this.action
    this.clearHold()
    this.action = null
    this.interacting = false
    if (a?.kind === 'erase') {
      a.removed.forEach((s) => this.hidden.delete(s.id))
      for (const s of a.added) this.remove(s)
      a.removed.forEach((s) => this.insert(s, true))
      this.invalidate(a.pageId)
    }
    if (a?.kind === 'move') {
      this.selection?.ids.forEach((id) => this.hidden.delete(id))
      this.invalidate(a.pageId)
    }
    this.needsLive = true
    this.requestBase()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.stopMomentum()
    const p = this.local(e)
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      this.zoomAt(this.zoom * Math.exp(-e.deltaY * 0.01), p.x, p.y)
    } else {
      this.camX += e.deltaX
      this.camY += e.deltaY
      this.clampCamera()
    }
    this.interacting = true
    this.requestBase()
    this.emitView()
    this.settle()
  }

  // ---------------------------------------------------------------- gestures

  private beginGesture(continuing = false) {
    const pts = [...this.touches.values()]
    const mid = centroid(pts)
    const prev = this.gesture
    this.gesture = {
      startDist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
      startZoom: this.zoom,
      startMid: mid,
      startCam: { x: this.camX, y: this.camY },
      startTime: continuing && prev ? prev.startTime : performance.now(),
      moved: continuing && prev ? prev.moved : false,
      maxTouches: Math.max(prev && continuing ? prev.maxTouches : 0, pts.length),
      last: { ...mid, t: performance.now() },
      vx: 0,
      vy: 0,
    }
    this.interacting = true
  }

  private updateGesture() {
    const g = this.gesture!
    const pts = [...this.touches.values()]
    const mid = centroid(pts)
    if (Math.hypot(mid.x - g.startMid.x, mid.y - g.startMid.y) > 8) g.moved = true
    const now = performance.now()
    const dt = Math.max(1, now - g.last.t)
    g.vx = ((mid.x - g.last.x) / dt) * 0.8 + g.vx * 0.2
    g.vy = ((mid.y - g.last.y) / dt) * 0.8 + g.vy * 0.2
    g.last = { ...mid, t: now }
    // Pan first (from the gesture's start camera), then zoom around the current midpoint.
    this.zoom = g.startZoom
    this.camX = g.startCam.x - (mid.x - g.startMid.x)
    this.camY = g.startCam.y - (mid.y - g.startMid.y)
    if (pts.length >= 2 && g.startDist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (Math.abs(dist - g.startDist) > 10) g.moved = true
      const docX = (g.startMid.x + g.startCam.x) / g.startZoom
      const docY = (g.startMid.y + g.startCam.y) / g.startZoom
      const z = Math.min(Math.max(g.startZoom * (dist / g.startDist), this.fitZoom * 0.5), this.fitZoom * 8)
      this.zoom = z
      this.camX = docX * z - mid.x
      this.camY = docY * z - mid.y
    }
    this.clampCamera()
    this.requestBase()
    this.emitView()
  }

  private endGesture() {
    const g = this.gesture!
    this.gesture = null
    const quick = performance.now() - g.startTime < TAP_MS * 1.5
    // GoodNotes-style shortcuts: two-finger tap undoes, three-finger tap redoes.
    if (quick && !g.moved) {
      if (g.maxTouches === 2) this.undo()
      else if (g.maxTouches >= 3) this.redo()
    } else if (g.maxTouches === 1 && performance.now() - g.last.t < 60) {
      this.startMomentum(g.vx, g.vy)
    }
    this.settle()
  }

  private startMomentum(vx: number, vy: number) {
    let vX = vx * 16, vY = vy * 16
    if (Math.hypot(vX, vY) < 2) return
    const step = () => {
      vX *= 0.94
      vY *= 0.94
      this.camX -= vX
      this.camY -= vY
      this.clampCamera()
      this.requestBase()
      this.emitView()
      if (Math.hypot(vX, vY) > 0.5) this.momentum = requestAnimationFrame(step)
      else {
        this.momentum = null
        this.settle()
      }
    }
    this.interacting = true
    this.momentum = requestAnimationFrame(step)
  }

  private stopMomentum() {
    if (this.momentum) cancelAnimationFrame(this.momentum)
    this.momentum = null
  }

  // ---------------------------------------------------------------- tools

  private armHold() {
    this.clearHold()
    if (!this.settings.holdToStraighten) return
    this.holdTimer = setTimeout(() => {
      const a = this.action
      if (a?.kind !== 'ink' || a.snapped) return
      const b = pointsBounds(a.points)
      if (Math.max(b.maxX - b.minX, b.maxY - b.minY) * this.zoom < 40) return
      a.snapped = true
      a.points = straightLine(a.points)
      a.predicted = []
      this.needsLive = true
      this.schedule()
    }, HOLD_MS)
  }

  private clearHold() {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  private finishInk(a: Extract<Action, { kind: 'ink' }>) {
    const stroke: StrokeRow = {
      id: uuidv7(),
      notebook_id: this.pageById(a.pageId)?.notebook_id ?? '',
      page_id: a.pageId,
      tool: a.tool,
      color: a.color,
      size: a.size,
      points: quantize(a.points),
      updated_at: nextTimestamp(),
      deleted: false,
      dirty: 1,
    }
    this.commit([{ before: { ...stroke, deleted: true }, after: stroke }])
  }

  private eraseAt(lp: LayoutPage, x: number, y: number) {
    const a = this.action
    if (a?.kind !== 'erase') return
    const r = this.settings.eraserSize / 2 / this.zoom
    // Interpolate between samples so fast swipes don't skip strokes.
    const steps = a.last ? Math.max(1, Math.ceil(Math.hypot(x - a.last.x, y - a.last.y) / (r * 0.5))) : 1
    const from = a.last ?? { x, y }
    a.last = { x, y }
    const list = this.strokes.get(lp.page.id) ?? []
    let changed = false
    for (let i = 1; i <= steps; i++) {
      const cx = from.x + ((x - from.x) * i) / steps
      const cy = from.y + ((y - from.y) * i) / steps
      const hit: Rect = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r }
      for (const s of [...list]) {
        if (!rectsIntersect(hit, pointsBounds(s.points, s.size / 2))) continue
        if (this.settings.eraserMode === 'stroke') {
          if (!polylineHitsCircle(s.points, cx, cy, r + s.size / 2)) continue
          this.removeForErase(a, s)
          changed = true
        } else {
          const runs = splitByCircle(s.points, cx, cy, r + s.size * 0.3)
          if (!runs) continue
          this.removeForErase(a, s)
          for (const run of runs) {
            const piece: StrokeRow = { ...s, id: uuidv7(), points: run, updated_at: 0 }
            this.insert(piece, true)
            a.added.push(piece)
          }
          changed = true
        }
      }
    }
    if (changed) {
      this.invalidate(lp.page.id)
      this.requestBase()
    }
  }

  private removeForErase(a: Extract<Action, { kind: 'erase' }>, s: StrokeRow) {
    this.remove(s)
    const addedIdx = a.added.indexOf(s)
    if (addedIdx >= 0) a.added.splice(addedIdx, 1) // a piece created during this same swipe
    else a.removed.set(s.id, s)
  }

  private finishLasso(a: Extract<Action, { kind: 'lasso' }>) {
    const ids = new Set<string>()
    for (const s of this.strokes.get(a.pageId) ?? []) if (strokeInLasso(s.points, a.poly)) ids.add(s.id)
    if (ids.size) {
      this.selection = { pageId: a.pageId, ids }
      this.emitSelection()
    } else this.clearSelection()
  }

  private drawHover(p: { x: number; y: number }) {
    this.hover = p
    this.needsLive = true
    this.schedule()
  }

  private hover: { x: number; y: number } | null = null

  // ---------------------------------------------------------------- rendering

  private invalidate(pageId: string) {
    const c = this.cache.get(pageId)
    if (c) c.valid = false
  }

  /** A sharper (or first) background bitmap arrived; ref null means any background. */
  private onBackgroundReady = (e: Event) => {
    const ref = (e as CustomEvent<string | null>).detail
    let hit = false
    for (const { page } of this.pages) {
      if (page.background && (ref === null || page.background === ref)) {
        this.invalidate(page.id)
        hit = true
      }
    }
    if (hit) this.requestBase()
  }

  private requestBase() {
    this.needsBase = true
    this.schedule()
  }

  private schedule() {
    if (this.frame || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderNow()
    })
  }

  /** After interaction stops, re-render page bitmaps at the final zoom. */
  private settle() {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.interacting = !!this.action || !!this.gesture || !!this.momentum
      this.requestBase()
      this.emitView()
      if (this.selection) this.emitSelection()
    }, 140)
  }

  private renderNow() {
    if (this.needsBase) {
      this.needsBase = false
      this.renderBase()
      if (this.selection) this.needsLive = true
    }
    if (this.needsLive) {
      this.needsLive = false
      this.renderLive()
    }
  }

  private visiblePages(): LayoutPage[] {
    const top = this.camY / this.zoom
    const bottom = (this.camY + this.height) / this.zoom
    return this.pages.filter((lp) => lp.y + lp.page.height >= top && lp.y <= bottom)
  }

  private renderBase() {
    const ctx = this.bctx
    const dark = document.documentElement.dataset.theme === 'dark'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = dark ? '#16181d' : '#e7e3da'
    ctx.fillRect(0, 0, this.base.width, this.base.height)
    const visible = this.visiblePages()
    const desired = this.zoom * this.dpr
    for (const lp of visible) {
      const { page } = lp
      const sx = -this.camX * this.dpr
      const sy = (lp.y * this.zoom - this.camY) * this.dpr
      const w = page.width * desired
      const h = page.height * desired
      // Paper shadow.
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.shadowColor = 'rgba(0,0,0,0.18)'
      ctx.shadowBlur = 10 * this.dpr
      ctx.shadowOffsetY = 2 * this.dpr
      ctx.fillStyle = '#fff'
      ctx.fillRect(sx, sy, w, h)
      ctx.shadowColor = 'transparent'

      const cacheScale = Math.min(desired, Math.sqrt(MAX_CACHE_PIXELS / (page.width * page.height)))
      if (cacheScale >= desired * 0.999) {
        const entry = this.ensureCache(page, desired)
        ctx.drawImage(entry.canvas, sx, sy, w, h)
      } else {
        // Deep zoom: draw vectors directly, clipped to the viewport.
        ctx.save()
        ctx.beginPath()
        ctx.rect(sx, sy, w, h)
        ctx.clip()
        ctx.setTransform(desired, 0, 0, desired, sx, sy)
        const view: Rect = {
          minX: this.camX / this.zoom,
          minY: this.camY / this.zoom - lp.y,
          maxX: (this.camX + this.width) / this.zoom,
          maxY: (this.camY + this.height) / this.zoom - lp.y,
        }
        const strokes = (this.strokes.get(page.id) ?? []).filter((s) => !this.hidden.has(s.id) && rectsIntersect(view, pointsBounds(s.points, s.size)))
        // The background itself stays a bitmap, capped at the cache resolution.
        drawPage(ctx, page, strokes, backgroundImage(page.background, page.width * cacheScale))
        ctx.restore()
      }
    }
    this.evictCache(visible)
  }

  private ensureCache(page: PageRow, desired: number): CacheEntry {
    let entry = this.cache.get(page.id)
    // While zooming, reuse the stale bitmap (scaled) and re-render once the gesture settles.
    const scaleOk = entry && (Math.abs(entry.scale - desired) < 0.001 || this.interacting)
    if (entry && entry.valid && scaleOk) return entry
    if (!entry) {
      entry = { canvas: document.createElement('canvas'), scale: 0, valid: false }
      this.cache.set(page.id, entry)
    }
    const scale = this.interacting && entry.scale > 0 && entry.valid ? entry.scale : desired
    entry.canvas.width = Math.ceil(page.width * scale)
    entry.canvas.height = Math.ceil(page.height * scale)
    entry.scale = scale
    const ctx = entry.canvas.getContext('2d')!
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const strokes = (this.strokes.get(page.id) ?? []).filter((s) => !this.hidden.has(s.id))
    drawPage(ctx, page, strokes, backgroundImage(page.background, entry.canvas.width))
    entry.valid = true
    return entry
  }

  private evictCache(visible: LayoutPage[]) {
    if (this.cache.size <= MAX_CACHED_PAGES) return
    const keep = new Set(visible.map((lp) => lp.page.id))
    for (const id of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHED_PAGES) break
      if (!keep.has(id)) this.cache.delete(id)
    }
  }

  private renderLive() {
    const ctx = this.lctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.live.width, this.live.height)
    const a = this.action

    if (this.selection) this.drawSelection(ctx)

    if (a?.kind === 'ink') {
      const lp = this.layoutOf(a.pageId)
      if (!lp) return
      this.pageTransform(ctx, lp, true)
      const pts = a.predicted.length ? a.points.concat(a.predicted) : a.points
      const path = outlineToPath(strokeOutline(a.tool, a.size, pts, false))
      ctx.fillStyle = inkColor(a.color, lp.page.paper)
      if (a.tool === 'highlighter') ctx.globalAlpha = HIGHLIGHTER_ALPHA
      ctx.fill(path)
      ctx.globalAlpha = 1
    } else if (a?.kind === 'lasso') {
      const lp = this.layoutOf(a.pageId)
      if (!lp || a.poly.length < 4) return
      this.pageTransform(ctx, lp, true)
      ctx.beginPath()
      ctx.moveTo(a.poly[0], a.poly[1])
      for (let i = 2; i < a.poly.length; i += 2) ctx.lineTo(a.poly[i], a.poly[i + 1])
      ctx.closePath()
      ctx.fillStyle = 'rgba(59,91,219,0.08)'
      ctx.fill()
      ctx.setLineDash([6 / this.zoom, 6 / this.zoom])
      ctx.lineWidth = 1.5 / this.zoom
      ctx.strokeStyle = '#3b5bdb'
      ctx.stroke()
      ctx.setLineDash([])
    }

    const eraserPos = a?.kind === 'erase' && a.last ? this.toScreenFromPage(a.pageId, a.last) : this.settings.tool === 'eraser' ? this.hover : null
    if (eraserPos) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.beginPath()
      ctx.arc(eraserPos.x, eraserPos.y, this.settings.eraserSize / 2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.stroke()
    }
  }

  private toScreenFromPage(pageId: string, p: { x: number; y: number }) {
    const lp = this.layoutOf(pageId)
    return lp ? this.toScreen(lp, p.x, p.y) : null
  }

  private pageTransform(ctx: CanvasRenderingContext2D, lp: LayoutPage, clip: boolean) {
    const s = this.zoom * this.dpr
    const ox = -this.camX * this.dpr
    const oy = (lp.y * this.zoom - this.camY) * this.dpr
    ctx.setTransform(s, 0, 0, s, ox, oy)
    if (clip) {
      ctx.beginPath()
      ctx.rect(0, 0, lp.page.width, lp.page.height)
      ctx.clip()
    }
  }

  private drawSelection(ctx: CanvasRenderingContext2D) {
    const sel = this.selection!
    const lp = this.layoutOf(sel.pageId)
    const bounds = this.selectionBounds()
    if (!lp || !bounds) return
    const a = this.action
    const dx = a?.kind === 'move' ? a.dx : 0
    const dy = a?.kind === 'move' ? a.dy : 0
    ctx.save()
    this.pageTransform(ctx, lp, false)
    ctx.translate(dx, dy)
    if (a?.kind === 'move') {
      for (const id of sel.ids) {
        const s = this.byId.get(id)
        if (s) drawStroke(ctx, s, lp.page.paper)
      }
    }
    const pad = 6 / this.zoom
    ctx.setLineDash([5 / this.zoom, 4 / this.zoom])
    ctx.lineWidth = 1.5 / this.zoom
    ctx.strokeStyle = '#3b5bdb'
    ctx.strokeRect(bounds.minX - pad, bounds.minY - pad, bounds.maxX - bounds.minX + pad * 2, bounds.maxY - bounds.minY + pad * 2)
    ctx.restore()
  }
}

function preventDefault(e: Event) {
  e.preventDefault()
}

function byId(a: StrokeRow, b: StrokeRow) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function centroid(pts: { x: number; y: number }[]) {
  let x = 0, y = 0
  for (const p of pts) {
    x += p.x
    y += p.y
  }
  return { x: x / pts.length, y: y / pts.length }
}

function inside(r: Rect, x: number, y: number, pad: number) {
  return x >= r.minX - pad && x <= r.maxX + pad && y >= r.minY - pad && y <= r.maxY + pad
}

/** Pen pressure; mice and fingers report 0.5 (or 0) which we normalize. */
function pressureOf(e: PointerEvent): number {
  if (e.pointerType === 'pen') return Math.max(0.05, Math.min(1, e.pressure || 0.5))
  return 0.5
}

/** Match the wire precision so local and synced copies render identically. */
function quantize(points: number[]): number[] {
  const out = new Array<number>(points.length)
  for (let i = 0; i < points.length; i += 3) {
    out[i] = Math.round(points[i] * 8) / 8
    out[i + 1] = Math.round(points[i + 1] * 8) / 8
    out[i + 2] = Math.round(points[i + 2] * 32767) / 32767
  }
  return out
}
