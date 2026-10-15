import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { EditorSettings } from '../engine/Editor'
import type { Paper, Template } from '../engine/types'

export const PEN_COLORS = ['#1a1a1a', '#1c4fd8', '#d62828', '#2b8a3e', '#7b2cbf']
export const HIGHLIGHTER_COLORS = ['#ffe066', '#8ce99a', '#74c0fc', '#ffa8a8', '#e599f7']
export const PEN_SIZES = [2.2, 3.6, 6]
export const HIGHLIGHTER_SIZES = [14, 22, 32]
export const ERASER_SIZES = [16, 32, 60]

interface SettingsState extends EditorSettings {
  penPalette: string[]
  highlighterPalette: string[]
  defaultTemplate: Template
  defaultPaper: Paper
  set(patch: Partial<SettingsState>): void
}

/** localStorage can throw (private mode, blocked storage); settings then simply aren't remembered. */
const safeStorage = createJSONStorage(() => ({
  getItem: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  },
}))

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      tool: 'pen',
      penStyle: 'fountain',
      penColor: PEN_COLORS[0],
      highlighterColor: HIGHLIGHTER_COLORS[0],
      penSize: PEN_SIZES[1],
      highlighterSize: HIGHLIGHTER_SIZES[1],
      eraserSize: ERASER_SIZES[1],
      eraserMode: 'stroke',
      stylusOnly: false,
      holdToStraighten: true,
      penPalette: PEN_COLORS,
      highlighterPalette: HIGHLIGHTER_COLORS,
      defaultTemplate: 'lined',
      defaultPaper: 'white',
      set: (patch) => set(patch),
    }),
    { name: 'hands-notes-settings', storage: safeStorage, version: 1 },
  ),
)

export function editorSettingsOf(s: SettingsState): EditorSettings {
  return {
    tool: s.tool,
    penStyle: s.penStyle,
    penColor: s.penColor,
    highlighterColor: s.highlighterColor,
    penSize: s.penSize,
    highlighterSize: s.highlighterSize,
    eraserSize: s.eraserSize,
    eraserMode: s.eraserMode,
    stylusOnly: s.stylusOnly,
    holdToStraighten: s.holdToStraighten,
  }
}
