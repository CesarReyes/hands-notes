import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../data/db'
import { addPage, duplicatePage, liveStrokes, livePages, movePage, putStrokes, strokeEvents, touchNotebook, updateNotebook, updatePage, type StrokeEventDetail } from '../data/repo'
import { Editor, type SelectionInfo } from '../engine/Editor'
import { exportNotebookPdf } from '../engine/pdf'
import { loadFileBytes, loadImageFile, saveImageFile } from '../data/files'
import { MAX_IMAGE_BYTES, prepareImage, rememberImage } from '../engine/images'
import type { PageRow, Paper, PenStyle, StrokeRow, Template, Tool } from '../engine/types'
import { editorSettingsOf, ERASER_SIZES, HIGHLIGHTER_SIZES, PEN_SIZES, useSettings } from '../store/settings'
import { MenuItem, Popover, Segmented, Toggle } from './common'
import {
  IconArrowDown,
  IconArrowUp,
  IconBack,
  IconCopy,
  IconDownload,
  IconEraser,
  IconHighlighter,
  IconImage,
  IconLasso,
  IconMore,
  IconPages,
  IconPen,
  IconPlus,
  IconRedo,
  IconTrash,
  IconUndo,
  IconX,
  IconZoomReset,
} from './icons'
import { PAPER_LABELS, TEMPLATE_LABELS } from './Library'
import { PageThumb } from './PageThumb'
import { SyncBadge } from './SyncBadge'

const PEN_STYLE_LABELS: Record<PenStyle, string> = { fountain: 'Pluma fuente', ballpoint: 'Bolígrafo', brush: 'Pincel' }

export function NotebookView({ notebookId, onBack }: { notebookId: string; onBack(): void }) {
  const notebook = useLiveQuery(() => db.notebooks.get(notebookId), [notebookId])
  const pages = useLiveQuery(() => livePages(notebookId), [notebookId])
  const settings = useSettings()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [view, setView] = useState({ pageIndex: 0, zoom: 1, fitZoom: 1 })
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [panel, setPanel] = useState(false)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [toolMenu, setToolMenu] = useState<{ tool: Tool; anchor: HTMLElement } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200)
  }, [])

  // Create the editor once per notebook.
  useEffect(() => {
    const host = hostRef.current!
    const editor = new Editor(host, editorSettingsOf(useSettings.getState()), {
      onCommit: (rows) => {
        void putStrokes(rows)
        // Bump the notebook's modified time at most every few seconds while writing.
        if (!touchTimer.current) {
          touchTimer.current = setTimeout(() => {
            touchTimer.current = null
            void touchNotebook(notebookId)
          }, 3000)
        }
      },
      onHistory: setHistory,
      onView: setView,
      onSelection: setSelection,
      onStylusDetected: () => {
        const s = useSettings.getState()
        if (!s.stylusOnly) {
          s.set({ stylusOnly: true })
          showToast('Lápiz detectado: ahora los dedos desplazan y hacen zoom. Cámbialo en ⋯ › Ajustes.')
        }
      },
    })
    editorRef.current = editor
    let cancelled = false
    void liveStrokes(notebookId).then((rows) => !cancelled && editor.setStrokes(rows))
    const onStrokes = (e: Event) => {
      const { rows } = (e as CustomEvent<StrokeEventDetail>).detail
      const mine = rows.filter((r) => r.notebook_id === notebookId)
      if (mine.length) editor.applyExternal(mine)
    }
    strokeEvents.addEventListener('strokes', onStrokes)
    return () => {
      cancelled = true
      strokeEvents.removeEventListener('strokes', onStrokes)
      if (touchTimer.current) {
        clearTimeout(touchTimer.current)
        touchTimer.current = null
        void touchNotebook(notebookId)
      }
      editor.dispose()
      editorRef.current = null
    }
  }, [notebookId, showToast])

  useEffect(() => {
    if (pages) editorRef.current?.setPages(pages)
  }, [pages])

  useEffect(() => {
    editorRef.current?.setSettings(editorSettingsOf(settings))
  }, [settings])

  // The notebook was deleted (here or on another device).
  useEffect(() => {
    if (notebook?.deleted) onBack()
  }, [notebook?.deleted, onBack])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) editorRef.current?.redo()
        else editorRef.current?.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        editorRef.current?.redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        editorRef.current?.deleteSelection()
      } else if (!mod) {
        const map: Record<string, Tool> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso' }
        if (map[e.key]) useSettings.getState().set({ tool: map[e.key] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const currentPage: PageRow | undefined = pages?.[Math.min(view.pageIndex, (pages?.length ?? 1) - 1)]

  const selectTool = (tool: Tool, anchor: HTMLElement) => {
    if (settings.tool === tool && tool !== 'lasso') setToolMenu({ tool, anchor })
    else settings.set({ tool })
  }

  const addPageAfterCurrent = async () => {
    if (!currentPage) return
    await addPage(notebookId, currentPage.id, currentPage.template, currentPage.paper)
    // Wait for the live query to deliver the new layout, then scroll to it.
    setTimeout(() => editorRef.current?.scrollToPage(view.pageIndex + 1), 120)
  }

  const insertImage = useCallback(
    async (file: Blob) => {
      try {
        const img = await prepareImage(file)
        if (img.data.byteLength > MAX_IMAGE_BYTES) throw new Error('too big')
        const fileId = await saveImageFile(img.data, img.type)
        rememberImage(fileId, img.bitmap)
        // Switch to the lasso so the new image can be moved and resized right away.
        useSettings.getState().set({ tool: 'lasso' })
        editorRef.current?.insertImage(fileId, img.width, img.height)
      } catch (e) {
        console.warn('Image insert failed', e)
        showToast('No se pudo insertar la imagen')
      }
    },
    [showToast],
  )

  // Paste a screenshot or copied image straight onto the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea')) return
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      void insertImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [insertImage])

  const exportPdf = async () => {
    if (!pages?.length) return
    showToast('Generando PDF…')
    const strokes = await liveStrokes(notebookId)
    const byPage = new Map<string, StrokeRow[]>()
    for (const s of strokes) {
      if (!byPage.has(s.page_id)) byPage.set(s.page_id, [])
      byPage.get(s.page_id)!.push(s)
    }
    try {
      await exportNotebookPdf(notebook?.title ?? 'Notas', pages, byPage, loadFileBytes, loadImageFile)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'No se pudo exportar')
    }
  }

  return (
    <div className="notebook">
      <header className="toolbar">
        <div className="toolbar-group">
          <button className="icon-btn" onClick={onBack} aria-label="Volver a la biblioteca">
            <IconBack />
          </button>
          {editingTitle ? (
            <input
              className="title-input"
              autoFocus
              defaultValue={notebook?.title}
              onBlur={(e) => {
                setEditingTitle(false)
                if (e.target.value.trim() !== notebook?.title) void updateNotebook(notebookId, { title: e.target.value.trim() })
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="title" onClick={() => setEditingTitle(true)}>
              {notebook?.title || 'Sin título'}
            </button>
          )}
        </div>

        <div className="toolbar-group tools" role="toolbar" aria-label="Herramientas">
          <ToolButton tool="pen" label="Pluma" active={settings.tool} onSelect={selectTool}>
            <IconPen />
          </ToolButton>
          <ToolButton tool="highlighter" label="Resaltador" active={settings.tool} onSelect={selectTool}>
            <IconHighlighter />
          </ToolButton>
          <ToolButton tool="eraser" label="Borrador" active={settings.tool} onSelect={selectTool}>
            <IconEraser />
          </ToolButton>
          <ToolButton tool="lasso" label="Lazo" active={settings.tool} onSelect={selectTool}>
            <IconLasso />
          </ToolButton>
          <button className="icon-btn" onClick={() => imageInput.current?.click()} aria-label="Insertar imagen" title="Insertar imagen">
            <IconImage />
          </button>
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void insertImage(file)
            }}
          />
          <span className="divider" />
          <ToolOptions />
        </div>

        <div className="toolbar-group">
          <button className="icon-btn" disabled={!history.canUndo} onClick={() => editorRef.current?.undo()} aria-label="Deshacer">
            <IconUndo />
          </button>
          <button className="icon-btn" disabled={!history.canRedo} onClick={() => editorRef.current?.redo()} aria-label="Rehacer">
            <IconRedo />
          </button>
          <button className={`icon-btn${panel ? ' active' : ''}`} onClick={() => setPanel((p) => !p)} aria-label="Páginas">
            <IconPages />
          </button>
          <button className="icon-btn" onClick={(e) => setMenu(e.currentTarget)} aria-label="Más opciones">
            <IconMore />
          </button>
          <SyncBadge compact />
        </div>
      </header>

      <div className="workspace">
        {panel && pages && (
          <PagePanel
            notebookId={notebookId}
            pages={pages}
            current={view.pageIndex}
            onGo={(i) => editorRef.current?.scrollToPage(i)}
            onClose={() => setPanel(false)}
          />
        )}
        <div className="canvas-host" ref={hostRef}>
          {selection && (
            <SelectionMenu
              info={selection}
              onDelete={() => editorRef.current?.deleteSelection()}
              onDuplicate={() => editorRef.current?.duplicateSelection()}
              onColor={(c) => editorRef.current?.recolorSelection(c)}
            />
          )}
          <div className="page-indicator">
            {Math.abs(view.zoom / view.fitZoom - 1) > 0.02 && (
              <button className="chip" onClick={() => editorRef.current?.resetZoom()} aria-label="Ajustar al ancho">
                <IconZoomReset size={16} />
                {Math.round((view.zoom / view.fitZoom) * 100)}%
              </button>
            )}
            <span className="chip">
              {Math.min(view.pageIndex + 1, pages?.length ?? 1)} / {pages?.length ?? 1}
            </span>
            <button className="chip" onClick={() => void addPageAfterCurrent()} aria-label="Añadir página">
              <IconPlus size={16} />
            </button>
          </div>
          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>

      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} align="end">
          {!currentPage?.background && (
          <div className="menu-section">
            <span className="label">Papel de esta página</span>
            {currentPage && (
              <>
                <Segmented
                  value={currentPage.template}
                  onChange={(t: Template) => void updatePage(currentPage.id, { template: t })}
                  options={(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => ({ value: t, label: TEMPLATE_LABELS[t] }))}
                />
                <Segmented
                  value={currentPage.paper}
                  onChange={(p: Paper) => void updatePage(currentPage.id, { paper: p })}
                  options={(Object.keys(PAPER_LABELS) as Paper[]).map((p) => ({ value: p, label: PAPER_LABELS[p] }))}
                />
              </>
            )}
          </div>
          )}
          <MenuItem
            icon={<IconPlus size={18} />}
            onClick={() => {
              setMenu(null)
              void addPageAfterCurrent()
            }}
          >
            Añadir página
          </MenuItem>
          <MenuItem
            icon={<IconDownload size={18} />}
            onClick={() => {
              setMenu(null)
              void exportPdf()
            }}
          >
            Exportar PDF
          </MenuItem>
          <div className="menu-section">
            <span className="label">Ajustes</span>
            <Toggle checked={settings.stylusOnly} onChange={(v) => settings.set({ stylusOnly: v })} label="Escribir solo con lápiz" hint="Los dedos desplazan y hacen zoom" />
            <Toggle checked={settings.holdToStraighten} onChange={(v) => settings.set({ holdToStraighten: v })} label="Mantener para línea recta" hint="Termina un trazo y espera un instante" />
          </div>
          <p className="menu-hint">Toque con dos dedos: deshacer · tres dedos: rehacer</p>
        </Popover>
      )}

      {toolMenu && (
        <Popover anchor={toolMenu.anchor} onClose={() => setToolMenu(null)}>
          {toolMenu.tool === 'pen' && (
            <div className="menu-section">
              <span className="label">Tipo de pluma</span>
              <Segmented value={settings.penStyle} onChange={(v: PenStyle) => settings.set({ penStyle: v })} options={(Object.keys(PEN_STYLE_LABELS) as PenStyle[]).map((v) => ({ value: v, label: PEN_STYLE_LABELS[v] }))} />
            </div>
          )}
          {toolMenu.tool === 'eraser' && (
            <div className="menu-section">
              <span className="label">Borrar</span>
              <Segmented
                value={settings.eraserMode}
                onChange={(v: 'stroke' | 'partial') => settings.set({ eraserMode: v })}
                options={[
                  { value: 'stroke', label: 'Trazo completo' },
                  { value: 'partial', label: 'Parcial' },
                ]}
              />
            </div>
          )}
          {toolMenu.tool === 'highlighter' && <p className="menu-hint">El resaltador queda detrás de la tinta, como en papel.</p>}
        </Popover>
      )}
    </div>
  )
}

function ToolButton({ tool, label, active, onSelect, children }: { tool: Tool; label: string; active: Tool; onSelect(t: Tool, el: HTMLElement): void; children: React.ReactNode }) {
  return (
    <button className={`icon-btn tool${active === tool ? ' active' : ''}`} aria-pressed={active === tool} aria-label={label} title={label} onClick={(e) => onSelect(tool, e.currentTarget)}>
      {children}
    </button>
  )
}

/** Colors and sizes for the active tool; tapping the active color again edits it. */
function ToolOptions() {
  const s = useSettings()
  const colorInput = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<number | null>(null)

  if (s.tool === 'lasso') return <span className="hint">Encierra trazos para moverlos</span>

  const isHl = s.tool === 'highlighter'
  const palette = isHl ? s.highlighterPalette : s.penPalette
  const color = isHl ? s.highlighterColor : s.penColor
  const sizes = s.tool === 'eraser' ? ERASER_SIZES : isHl ? HIGHLIGHTER_SIZES : PEN_SIZES
  const size = s.tool === 'eraser' ? s.eraserSize : isHl ? s.highlighterSize : s.penSize
  const setSize = (v: number) => s.set(s.tool === 'eraser' ? { eraserSize: v } : isHl ? { highlighterSize: v } : { penSize: v })

  const pickColor = (c: string, i: number) => {
    if (c === color) {
      setEditing(i)
      colorInput.current?.click()
      return
    }
    s.set(isHl ? { highlighterColor: c, tool: 'highlighter' } : { penColor: c })
  }

  const onCustom = (value: string) => {
    if (editing === null) return
    const next = palette.slice()
    next[editing] = value
    s.set(isHl ? { highlighterPalette: next, highlighterColor: value } : { penPalette: next, penColor: value })
  }

  return (
    <>
      {s.tool !== 'eraser' && (
        <div className="swatches compact" role="radiogroup" aria-label="Color">
          {palette.map((c, i) => (
            <button key={i} role="radio" aria-checked={c === color} className={`swatch${c === color ? ' active' : ''}`} style={{ background: c }} onClick={() => pickColor(c, i)} aria-label={`Color ${c}`} />
          ))}
          <input ref={colorInput} type="color" className="hidden-color" value={color} onChange={(e) => onCustom(e.target.value)} tabIndex={-1} aria-hidden="true" />
        </div>
      )}
      <div className="sizes" role="radiogroup" aria-label="Grosor">
        {sizes.map((v, i) => (
          <button key={v} role="radio" aria-checked={v === size} className={`size${v === size ? ' active' : ''}`} onClick={() => setSize(v)} aria-label={`Grosor ${i + 1}`}>
            <span style={{ width: 6 + i * 6, height: 6 + i * 6, background: s.tool === 'eraser' ? 'transparent' : color, opacity: isHl ? 0.6 : 1 }} />
          </button>
        ))}
      </div>
    </>
  )
}

function SelectionMenu({ info, onDelete, onDuplicate, onColor }: { info: SelectionInfo; onDelete(): void; onDuplicate(): void; onColor(c: string): void }) {
  const palette = useSettings((s) => s.penPalette)
  const { x, y, width } = info.screenRect
  const top = Math.max(8, y - 56)
  return (
    <div className="selection-menu" style={{ left: Math.max(8, x + width / 2), top }} onPointerDown={(e) => e.stopPropagation()}>
      <span className="count">{info.count}</span>
      {info.colorable && palette.map((c) => (
        <button key={c} className="swatch tiny" style={{ background: c }} onClick={() => onColor(c)} aria-label={`Cambiar a ${c}`} />
      ))}
      <button className="icon-btn small" onClick={onDuplicate} aria-label="Duplicar">
        <IconCopy size={18} />
      </button>
      <button className="icon-btn small danger" onClick={onDelete} aria-label="Eliminar selección">
        <IconTrash size={18} />
      </button>
    </div>
  )
}

function PagePanel({ notebookId, pages, current, onGo, onClose }: { notebookId: string; pages: PageRow[]; current: number; onGo(i: number): void; onClose(): void }) {
  const strokes = useLiveQuery(() => liveStrokes(notebookId), [notebookId])
  const byPage = new Map<string, StrokeRow[]>()
  for (const s of strokes ?? []) {
    if (!byPage.has(s.page_id)) byPage.set(s.page_id, [])
    byPage.get(s.page_id)!.push(s)
  }
  return (
    <aside className="page-panel" aria-label="Páginas">
      <header>
        <span>Páginas</span>
        <button className="icon-btn small" onClick={onClose} aria-label="Cerrar panel">
          <IconX size={18} />
        </button>
      </header>
      <ol>
        {pages.map((p, i) => (
          <li key={p.id} className={i === current ? 'current' : ''}>
            <button className="thumb-btn" onClick={() => onGo(i)} aria-label={`Ir a la página ${i + 1}`}>
              <PageThumb page={p} strokes={byPage.get(p.id) ?? []} width={120} />
            </button>
            <div className="page-actions">
              <span>{i + 1}</span>
              <button className="icon-btn small" disabled={i === 0} onClick={() => void movePage(notebookId, p.id, i - 1)} aria-label="Subir página">
                <IconArrowUp size={16} />
              </button>
              <button className="icon-btn small" disabled={i === pages.length - 1} onClick={() => void movePage(notebookId, p.id, i + 1)} aria-label="Bajar página">
                <IconArrowDown size={16} />
              </button>
              <button className="icon-btn small" onClick={() => void duplicatePage(notebookId, p.id)} aria-label="Duplicar página">
                <IconCopy size={16} />
              </button>
              <button
                className="icon-btn small danger"
                disabled={pages.length === 1}
                onClick={() => window.confirm(`¿Eliminar la página ${i + 1}?`) && void updatePage(p.id, { deleted: true })}
                aria-label="Eliminar página"
              >
                <IconTrash size={16} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <button className="btn" onClick={() => void addPage(notebookId, null, pages.at(-1)!.template, pages.at(-1)!.paper)}>
        <IconPlus size={18} /> Página al final
      </button>
    </aside>
  )
}
