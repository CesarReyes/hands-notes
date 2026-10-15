import type { jsPDF as JsPDF } from 'jspdf'
import { HIGHLIGHTER_ALPHA, inkColor, PAPER_COLORS, strokeOutline } from './render'
import type { PageRow, StrokeRow } from './types'

const A4_WIDTH_PT = 595.28

/** Vector PDF export: ink stays sharp at any zoom, like GoodNotes' own export. */
export async function exportNotebookPdf(title: string, pages: PageRow[], strokesByPage: Map<string, StrokeRow[]>) {
  const { jsPDF, GState } = await import('jspdf')
  const first = pages[0]
  const k = A4_WIDTH_PT / (first?.width ?? 1000)
  const doc = new jsPDF({ unit: 'pt', format: [first.width * k, first.height * k], compress: true })
  const translucent = new GState({ opacity: HIGHLIGHTER_ALPHA })
  const opaque = new GState({ opacity: 1 })

  pages.forEach((page, i) => {
    if (i > 0) doc.addPage([page.width * k, page.height * k])
    drawPaperPdf(doc, page, k)
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

  const safe = (title || 'Notas').replace(/[\\/:*?"<>|]+/g, '-').trim()
  doc.save(`${safe}.pdf`)
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
