export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso'
export type InkTool = 'pen' | 'highlighter'
export type PenStyle = 'fountain' | 'ballpoint' | 'brush'
export type Template = 'blank' | 'lined' | 'grid' | 'dots' | 'cornell'
export type Paper = 'white' | 'cream' | 'dark'

/** Logical page size (A4 ratio). All stroke coordinates are in page units. */
export const PAGE_WIDTH = 1000
export const PAGE_HEIGHT = 1414

export interface NotebookRow {
  id: string
  title: string
  cover: string
  created_at: number
  updated_at: number
  deleted: boolean
  dirty: 0 | 1
}

export interface PageRow {
  id: string
  notebook_id: string
  /** Fractional ordering key so inserts never renumber siblings. */
  position: number
  template: Template
  paper: Paper
  width: number
  height: number
  /** What sits under the ink instead of ruled paper, e.g. an imported PDF page. See background.ts. */
  background: string | null
  updated_at: number
  deleted: boolean
  dirty: 0 | 1
}

/** An imported document, cached locally and mirrored to Supabase Storage. Its bytes never change. */
export interface FileRow {
  id: string
  /** Raw bytes (ArrayBuffer rather than Blob: older iOS Safari mishandles Blobs in IndexedDB). */
  data: ArrayBuffer
  size: number
  /** 1 until the bytes are in Storage. */
  dirty: 0 | 1
}

/**
 * A stroke is immutable ink apart from moves/recolors. `points` is a flat
 * [x, y, pressure, x, y, pressure, ...] array in page coordinates.
 * `tool` encodes pen style for pens: 'pen:fountain' | 'pen:ballpoint' | 'pen:brush' | 'highlighter'.
 */
export interface StrokeRow {
  id: string
  notebook_id: string
  page_id: string
  tool: string
  color: string
  size: number
  points: number[]
  updated_at: number
  deleted: boolean
  dirty: 0 | 1
}

export interface Point {
  x: number
  y: number
  p: number
}

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}
