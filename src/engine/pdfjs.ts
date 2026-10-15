import type { PDFDocumentProxy } from 'pdfjs-dist'

type PdfJs = typeof import('pdfjs-dist')

let lib: Promise<PdfJs> | null = null

/** pdf.js is ~1.5 MB with its worker, so it only loads once a PDF is actually needed. */
export function loadPdfJs(): Promise<PdfJs> {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    return pdfjs
  })
  return lib
}

/** Opens a PDF from bytes. The bytes are copied because pdf.js transfers (detaches) its input. */
export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfJs()
  return pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise
}
