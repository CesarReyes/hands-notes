import type { StrokeRow } from './types'

/** One stroke's state before and after an edit. A non-existent stroke is represented with deleted: true. */
export interface StrokeChange {
  before: StrokeRow
  after: StrokeRow
}

export class History {
  private undoStack: StrokeChange[][] = []
  private redoStack: StrokeChange[][] = []
  constructor(private limit = 200) {}

  push(changes: StrokeChange[]) {
    if (!changes.length) return
    this.undoStack.push(changes)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  /** Returns the stroke states to restore, or null when there is nothing to undo. */
  undo(): StrokeRow[] | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push(entry)
    return entry.map((c) => c.before)
  }

  redo(): StrokeRow[] | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push(entry)
    return entry.map((c) => c.after)
  }

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  clear() {
    this.undoStack = []
    this.redoStack = []
  }
}
