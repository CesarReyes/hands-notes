import { useState, type FormEvent } from 'react'
import { supabase } from '../data/supabase'
import { IconNotebook } from './icons'

/** Sign-in only: accounts are created by the owner from the Supabase dashboard. */
export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(translateError(error.message))
    setBusy(false)
  }

  return (
    <div className="login">
      <form className="stack login-card" onSubmit={submit}>
        <div className="brand">
          <IconNotebook size={26} />
          <h1>Hands Notes</h1>
        </div>
        <p className="muted">Inicia sesión para abrir tus cuadernos.</p>
        <label className="field">
          <span>Correo</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Contraseña</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Un momento…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

function translateError(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'Correo o contraseña incorrectos.'
  if (/email not confirmed/i.test(msg)) return 'Esta cuenta aún no está confirmada.'
  if (/rate limit/i.test(msg)) return 'Demasiados intentos. Espera un momento e inténtalo de nuevo.'
  if (/fetch|network/i.test(msg)) return 'Sin conexión. Inténtalo cuando tengas internet.'
  return msg
}
