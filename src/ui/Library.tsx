import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useRef, useState } from 'react'
import { db } from '../data/db'
import { COVER_COLORS, createNotebook, ImportError, importPdf, updateNotebook } from '../data/repo'
import type { NotebookRow, Paper, Template } from '../engine/types'
import { useAuth } from '../store/auth'
import { useSettings } from '../store/settings'
import { AccountDialog } from './AccountDialog'
import { MenuItem, Modal, Popover, Segmented } from './common'
import { IconImport, IconMore, IconNotebook, IconPlus, IconSearch, IconTrash, IconUser } from './icons'
import { PageThumb } from './PageThumb'
import { SyncBadge } from './SyncBadge'

export const TEMPLATE_LABELS: Record<Template, string> = {
  lined: 'Rayado',
  grid: 'Cuadriculado',
  dots: 'Puntos',
  blank: 'En blanco',
  cornell: 'Cornell',
}
export const PAPER_LABELS: Record<Paper, string> = { white: 'Blanco', cream: 'Crema', dark: 'Oscuro' }

export function Library({ onOpen }: { onOpen(id: string): void }) {
  const notebooks = useLiveQuery(() => db.notebooks.orderBy('updated_at').reverse().toArray(), [])
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [account, setAccount] = useState(false)
  const session = useAuth((s) => s.session)
  const fileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const onPickPdf = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    try {
      const id = await importPdf(file, COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)])
      onOpen(id)
    } catch (e) {
      console.error(e)
      window.alert(e instanceof ImportError ? e.message : `No se pudo importar “${file.name}”. ¿Es un PDF válido?`)
    } finally {
      setImporting(false)
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (notebooks ?? []).filter((n) => !n.deleted && (!q || n.title.toLowerCase().includes(q)))
  }, [notebooks, query])

  return (
    <div className="library">
      <header className="library-header">
        <div className="brand">
          <IconNotebook size={26} />
          <h1>Hands Notes</h1>
        </div>
        <div className="search">
          <IconSearch size={18} />
          <input placeholder="Buscar cuadernos" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar cuadernos" />
        </div>
        <div className="row gap">
          <SyncBadge onClick={() => setAccount(true)} />
          <button className="icon-btn" onClick={() => setAccount(true)} aria-label="Cuenta">
            <IconUser />
          </button>
        </div>
      </header>

      {!session && notebooks && notebooks.length > 0 && (
        <button className="banner" onClick={() => setAccount(true)}>
          Tus notas solo están en este dispositivo. <strong>Inicia sesión</strong> para verlas en todas tus tablets.
        </button>
      )}

      <main className="grid">
        <button className="notebook-card new" onClick={() => setCreating(true)}>
          <div className="cover new-cover">
            <IconPlus size={40} />
          </div>
          <span className="nb-title">Nuevo cuaderno</span>
        </button>
        <button className="notebook-card new" onClick={() => fileInput.current?.click()} disabled={importing}>
          <div className="cover new-cover">
            <IconImport size={40} />
          </div>
          <span className="nb-title">{importing ? 'Importando…' : 'Importar PDF'}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            void onPickPdf(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {visible.map((n) => (
          <NotebookCard key={n.id} notebook={n} onOpen={() => onOpen(n.id)} />
        ))}
      </main>

      {notebooks && visible.length === 0 && query && <p className="empty">No hay cuadernos que coincidan con “{query}”.</p>}
      {creating && (
        <NewNotebookDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            onOpen(id)
          }}
        />
      )}
      {account && <AccountDialog onClose={() => setAccount(false)} />}
    </div>
  )
}

function NotebookCard({ notebook, onOpen }: { notebook: NotebookRow; onOpen(): void }) {
  const firstPage = useLiveQuery(async () => {
    const pages = await db.pages.where('notebook_id').equals(notebook.id).toArray()
    return pages.filter((p) => !p.deleted).sort((a, b) => a.position - b.position)[0] ?? null
  }, [notebook.id])
  const strokes = useLiveQuery(
    async () => (firstPage ? (await db.strokes.where('page_id').equals(firstPage.id).toArray()).filter((s) => !s.deleted) : []),
    [firstPage?.id, notebook.updated_at],
  )
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)

  return (
    <div className="notebook-card">
      <button className="cover" style={{ ['--cover' as string]: notebook.cover }} onClick={onOpen} aria-label={`Abrir ${notebook.title || 'Sin título'}`}>
        <span className="spine" />
        {firstPage && strokes && <PageThumb page={firstPage} strokes={strokes} width={150} />}
      </button>
      <div className="nb-meta">
        <div>
          <span className="nb-title">{notebook.title || 'Sin título'}</span>
          <span className="nb-date">{formatDate(notebook.updated_at)}</span>
        </div>
        <button className="icon-btn small" onClick={(e) => setMenu(e.currentTarget)} aria-label="Opciones del cuaderno">
          <IconMore size={18} />
        </button>
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} align="end">
          <MenuItem
            onClick={() => {
              setMenu(null)
              setRenaming(true)
            }}
          >
            Renombrar y portada
          </MenuItem>
          <MenuItem
            danger
            icon={<IconTrash size={18} />}
            onClick={() => {
              setMenu(null)
              if (window.confirm(`¿Eliminar “${notebook.title || 'Sin título'}”? Se borrará en todos tus dispositivos.`)) void updateNotebook(notebook.id, { deleted: true })
            }}
          >
            Eliminar
          </MenuItem>
        </Popover>
      )}
      {renaming && <RenameDialog notebook={notebook} onClose={() => setRenaming(false)} />}
    </div>
  )
}

function CoverPicker({ value, onChange }: { value: string; onChange(c: string): void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color de portada">
      {COVER_COLORS.map((c) => (
        <button key={c} role="radio" aria-checked={c === value} className={`swatch${c === value ? ' active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} type="button" />
      ))}
    </div>
  )
}

function RenameDialog({ notebook, onClose }: { notebook: NotebookRow; onClose(): void }) {
  const [title, setTitle] = useState(notebook.title)
  const [cover, setCover] = useState(notebook.cover)
  const save = () => {
    void updateNotebook(notebook.id, { title: title.trim(), cover })
    onClose()
  }
  return (
    <Modal
      title="Cuaderno"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={save}>
          Guardar
        </button>
      }
    >
      <div className="stack">
        <label className="field">
          <span>Título</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
        <CoverPicker value={cover} onChange={setCover} />
      </div>
    </Modal>
  )
}

function NewNotebookDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const settings = useSettings()
  const [title, setTitle] = useState('')
  const [cover, setCover] = useState(COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)])
  const [template, setTemplate] = useState<Template>(settings.defaultTemplate)
  const [paper, setPaper] = useState<Paper>(settings.defaultPaper)
  const create = async () => {
    settings.set({ defaultTemplate: template, defaultPaper: paper })
    const id = await createNotebook(title.trim() || 'Sin título', cover, template, paper)
    onCreated(id)
  }
  const preview = { id: 'preview', notebook_id: '', position: 0, template, paper, width: 1000, height: 1414, background: null, updated_at: 0, deleted: false, dirty: 0 as const }
  return (
    <Modal
      title="Nuevo cuaderno"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={() => void create()}>
          Crear
        </button>
      }
    >
      <div className="new-notebook">
        <div className="stack">
          <label className="field">
            <span>Título</span>
            <input autoFocus placeholder="Sin título" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          </label>
          <span className="label">Portada</span>
          <CoverPicker value={cover} onChange={setCover} />
          <span className="label">Papel</span>
          <Segmented<Template> value={template} onChange={setTemplate} options={(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => ({ value: t, label: TEMPLATE_LABELS[t] }))} />
          <Segmented<Paper> value={paper} onChange={setPaper} options={(Object.keys(PAPER_LABELS) as Paper[]).map((p) => ({ value: p, label: PAPER_LABELS[p] }))} />
        </div>
        <div className="preview">
          <PageThumb page={preview} strokes={[]} width={140} />
        </div>
      </div>
    </Modal>
  )
}

function formatDate(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
