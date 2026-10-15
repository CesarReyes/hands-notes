/**
 * Page backgrounds. A page's `background` is a short reference string:
 *   pdf:<fileId>:<pageNumber>   (pageNumber is 1-based, as in pdf.js)
 * Unknown formats are ignored by renderers, so newer kinds can be added later.
 */

export interface PdfBackground {
  kind: 'pdf'
  fileId: string
  page: number
}

export type Background = PdfBackground

export function pdfBackground(fileId: string, page: number): string {
  return `pdf:${fileId}:${page}`
}

export function parseBackground(ref: string | null | undefined): Background | null {
  if (!ref) return null
  const m = /^pdf:([0-9a-f-]{36}):(\d+)$/.exec(ref)
  if (!m) return null
  const page = Number(m[2])
  return page >= 1 ? { kind: 'pdf', fileId: m[1], page } : null
}
