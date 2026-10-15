import type { jsPDF as JsPDF } from 'jspdf'
import type { PDFDocument as PdfLibDocument } from 'pdf-lib'
import { parseBackground, type PdfBackground } from './background'
import { HIGHLIGHTER_ALPHA, inkColor, PAPER_COLORS, strokeOutline } from './render'
import type { PageRow, StrokeRow } from './types'

const A4_WIDTH_PT = 595.28

/**
 * Vector PDF export: ink stays sharp at any zoom, like GoodNotes' own export.
 * Pages imported from a PDF get their original page embedded (still vector)
 * under the ink; `loadFile` supplies that PDF's bytes.
 */
export async function exportNotebookPdf(
  title: string,
  pages: PageRow[],
  strokesByPage: Map<string, StrokeRow[]>,
  loadFile: (fileId: string) => Promise<ArrayBuffer>,
) {
  const { jsPDF, GState } = await import('jspdf')
  const first = pages[0]
  const k = A4_WIDTH_PT / (first?.width ?? 1000)
  // jsPDF swaps [w, h] to match the orientation (portrait by default), so always pass it.
  const orientation = (p: PageRow) => (p.width > p.height ? 'landscape' : 'portrait')
  const doc = new jsPDF({ unit: 'pt', format: [first.width * k, first.height * k], orientation: orientation(first), compress: true })
  const translucent = new GState({ opacity: HIGHLIGHTER_ALPHA })
  const opaque = new GState({ opacity: 1 })

  pages.forEach((page, i) => {
    if (i > 0) doc.addPage([page.width * k, page.height * k], orientation(page))
    // Background pages stay transparent here; the original page goes underneath later.
    if (!parseBackground(page.background)) drawPaperPdf(doc, page, k)
    const strokes = (strokesByPage.get(page.id) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    const ordered = [...strokes.filter((s) => s.tool === 'highlighter'), ...strokes.filter((s) => s.tool !== 'highlighter')]
    for (const s of ordered) {
      const outline = strokeOutline(s.tool, s.size, s.points)
      if (outline.length < 3) continue
      doc.setGState(s.tool === 'highlighter' ? translucent : opaque)
      doc.setFillColor(inkColor(s.color, page.paper))
      doc.moveTo(outline[0][0] * k, outline[0][1] * k)
      let [px, py] = outline[0]
      for (let j = 1; j < outline.length; j++) {
        const [x1, y1] = outline[j]
        const mx = (px + x1) / 2, my = (py + y1) / 2
        // Quadratic (control = previous point) expressed as a cubic Bézier.
        const sx = j === 1 ? px : (outline[j - 2][0] + px) / 2
        const sy = j === 1 ? py : (outline[j - 2][1] + py) / 2
        doc.curveTo(
          (sx + (2 / 3) * (px - sx)) * k, (sy + (2 / 3) * (py - sy)) * k,
          (mx + (2 / 3) * (px - mx)) * k, (my + (2 / 3) * (py - my)) * k,
          mx * k, my * k,
        )
        px = x1
        py = y1
      }
      doc.close()
      doc.fill()
    }
    doc.setGState(opaque)
  })

  const filename = `${(title || 'Notas').replace(/[\\/:*?"<>|]+/g, '-').trim()}.pdf`
  const backgrounds = pages.map((p) => parseBackground(p.background))
  if (!backgrounds.some(Boolean)) {
    doc.save(filename)
    return
  }
  const bytes = await underlayBackgrounds(doc.output('arraybuffer'), backgrounds, loadFile)
  download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), filename)
}

/** Rebuilds the ink-only PDF with each imported page drawn beneath its ink. */
async function underlayBackgrounds(
  inkPdf: ArrayBuffer,
  backgrounds: (PdfBackground | null)[],
  loadFile: (fileId: string) => Promise<ArrayBuffer>,
): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import('pdf-lib')
  const ink = await PDFDocument.load(inkPdf)
  const out = await PDFDocument.create()
  const sources = new Map<string, Promise<PdfLibDocument>>()
  const source = (fileId: string) => {
    let s = sources.get(fileId)
    if (!s) {
      s = loadFile(fileId).then((b) => PDFDocument.load(b, { ignoreEncryption: true }))
      sources.set(fileId, s)
    }
    return s
  }

  for (let i = 0; i < backgrounds.length; i++) {
    const bg = backgrounds[i]
    if (!bg) {
      const [copy] = await out.copyPages(ink, [i])
      out.addPage(copy)
      continue
    }
    const src = await source(bg.fileId)
    const srcPage = src.getPage(Math.min(bg.page, src.getPageCount()) - 1)
    const crop = srcPage.getCropBox()
    const original = await out.embedPage(srcPage, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height })
    const inkPage = await out.embedPage(ink.getPage(i))
    const { width: W, height: H } = ink.getPage(i).getSize()
    const page = out.addPage([W, H])
    // Match pdf.js, which shows the page with its /Rotate applied (pdf-lib rotates counterclockwise).
    const rot = ((srcPage.getRotation().angle % 360) + 360) % 360
    const sideways = rot === 90 || rot === 270
    // Fill the page exactly, as the canvas does (page heights are rounded to whole units).
    const xScale = (sideways ? H : W) / crop.width
    const yScale = (sideways ? W : H) / crop.height
    const at = { 0: { x: 0, y: 0 }, 90: { x: 0, y: H }, 180: { x: W, y: H }, 270: { x: W, y: 0 } }[rot as 0 | 90 | 180 | 270] ?? { x: 0, y: 0 }
    page.drawPage(original, { ...at, xScale, yScale, rotate: degrees(-rot) })
    page.drawPage(inkPage, { x: 0, y: 0 })
  }
  return out.save()
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function drawPaperPdf(doc: JsPDF, page: PageRow, k: number) {
  const c = PAPER_COLORS[page.paper]
  const w = page.width, h = page.height
  doc.setFillColor(c.bg)
  doc.rect(0, 0, w * k, h * k, 'F')
  doc.setDrawColor(c.line)
  doc.setFillColor(c.line)
  doc.setLineWidth(1.2 * k)
  const top = 110, gap = 36
  const hline = (y: number, x0 = 0, x1 = w) => doc.line(x0 * k, y * k, x1 * k, y * k)
  const vline = (x: number, y0 = 0, y1 = h) => doc.line(x * k, y0 * k, x * k, y1 * k)
  switch (page.template) {
    case 'lined':
      for (let y = top; y < h - 40; y += gap) hline(y)
      doc.setDrawColor(c.margin)
      vline(110)
      break
    case 'grid':
      doc.setLineWidth(0.9 * k)
      for (let x = 32; x < w; x += 32) vline(x)
      for (let y = 32; y < h; y += 32) hline(y)
      break
    case 'dots':
      for (let x = 32; x < w; x += 32) for (let y = 32; y < h; y += 32) doc.circle(x * k, y * k, 1.7 * k, 'F')
      break
    case 'cornell':
      for (let y = top; y < h - 300; y += gap) hline(y, 280)
      doc.setDrawColor(c.margin)
      doc.setLineWidth(2 * k)
      hline(top - gap)
      vline(250, top - gap, h - 280)
      hline(h - 280)
      break
    case 'blank':
      break
  }
}
