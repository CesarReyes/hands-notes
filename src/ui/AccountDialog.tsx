import { useState } from 'react'
import { sync, useSyncStatus } from '../data/sync'
import { supabaseConfigured } from '../data/supabase'
import { signOut, useAuth } from '../store/auth'
import { Modal } from './common'

export function AccountDialog({ onClose }: { onClose(): void }) {
  const session = useAuth((s) => s.session)
  return (
    <Modal title="Tu cuenta" onClose={onClose}>
      {!supabaseConfigured ? (
        <p className="muted">La sincronización no está configurada en esta compilación.</p>
      ) : session ? (
        <SignedIn email={session.user.email ?? ''} onClose={onClose} />
      ) : null}
    </Modal>
  )
}

function SignedIn({ email, onClose }: { email: string; onClose(): void }) {
  const { state, pending, lastSyncedAt, error } = useSyncStatus()
  const [busy, setBusy] = useState(false)
  return (
    <div className="stack">
      <p>
        Conectado como <strong>{email}</strong>
      </p>
      <dl className="facts">
        <dt>Estado</dt>
        <dd>{state === 'synced' ? 'Todo sincronizado' : state === 'offline' ? 'Sin conexión: tus cambios se guardan aquí y se envían al volver' : state === 'error' ? `Error: ${error}` : 'Sincronizando…'}</dd>
        <dt>Cambios pendientes</dt>
        <dd>{pending}</dd>
        {lastSyncedAt && (
          <>
            <dt>Última sincronización</dt>
            <dd>{new Date(lastSyncedAt).toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      <div className="row gap">
        <button className="btn" onClick={() => void sync.resume()}>
          Sincronizar ahora
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            if (pending > 0 && !window.confirm(`Hay ${pending} cambios sin enviar. Si cierras sesión sin conexión se perderán. ¿Continuar?`)) return
            setBusy(true)
            await signOut()
            setBusy(false)
            onClose()
          }}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}
