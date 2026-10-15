import { useState, type FormEvent } from 'react'
import { sync, useSyncStatus } from '../data/sync'
import { supabase, supabaseConfigured } from '../data/supabase'
import { signOut, useAuth } from '../store/auth'
import { Modal, Segmented } from './common'

type Mode = 'signin' | 'signup' | 'code'

export function AccountDialog({ onClose }: { onClose(): void }) {
  const session = useAuth((s) => s.session)
  return (
    <Modal title={session ? 'Tu cuenta' : 'Sincroniza tus notas'} onClose={onClose}>
      {!supabaseConfigured ? (
        <p className="muted">La sincronización no está configurada en esta compilación.</p>
      ) : session ? (
        <SignedIn email={session.user.email ?? ''} onClose={onClose} />
      ) : (
        <SignInForm onDone={onClose} />
      )}
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

function SignInForm({ onDone }: { onDone(): void }) {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onDone()
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
        if (error) throw error
        if (data.session) onDone()
        else {
          setMode('code')
          setCodeSent(true)
          setMessage({ kind: 'info', text: 'Te enviamos un correo. Escribe aquí el código de 6 dígitos (o abre el enlace).' })
        }
      } else if (!codeSent) {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
        if (error) throw error
        setCodeSent(true)
        setMessage({ kind: 'info', text: 'Revisa tu correo y escribe el código de 6 dígitos.' })
      } else {
        // A signup confirmation and a login code are both verified as an email OTP.
        let { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
        if (error) ({ error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'signup' }))
        if (error) throw error
        onDone()
      }
    } catch (err) {
      setMessage({ kind: 'error', text: translateError(err instanceof Error ? err.message : String(err)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted">Inicia sesión para abrir tus cuadernos actualizados en cualquier tablet. Lo que escribas sin conexión se sube después.</p>
      <Segmented
        value={mode}
        onChange={(m) => {
          setMode(m)
          setMessage(null)
          setCodeSent(false)
        }}
        options={[
          { value: 'signin', label: 'Entrar' },
          { value: 'signup', label: 'Crear cuenta' },
          { value: 'code', label: 'Código por correo' },
        ]}
      />
      <label className="field">
        <span>Correo</span>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {mode !== 'code' && (
        <label className="field">
          <span>Contraseña</span>
          <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      )}
      {mode === 'code' && codeSent && (
        <label className="field">
          <span>Código</span>
          <input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6,10}" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      {message && <p className={message.kind === 'error' ? 'error' : 'info'}>{message.text}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? 'Un momento…' : mode === 'signin' ? 'Entrar' : mode === 'signup' ? 'Crear cuenta' : codeSent ? 'Verificar código' : 'Enviar código'}
      </button>
    </form>
  )
}

function translateError(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'Correo o contraseña incorrectos.'
  if (/email not confirmed/i.test(msg)) return 'Confirma tu correo primero (usa la pestaña "Código por correo").'
  if (/already registered/i.test(msg)) return 'Ese correo ya tiene cuenta. Usa "Entrar".'
  if (/rate limit/i.test(msg)) return 'Demasiados intentos. Espera un momento e inténtalo de nuevo.'
  if (/expired|invalid.*otp|token/i.test(msg)) return 'El código no es válido o expiró.'
  if (/fetch|network/i.test(msg)) return 'Sin conexión. Inténtalo cuando tengas internet.'
  return msg
}
