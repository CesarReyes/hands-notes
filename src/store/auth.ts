import type { Session } from '@supabase/supabase-js'
import { create } from 'zustand'
import { clearLocalData, sync } from '../data/sync'
import { supabase, supabaseConfigured } from '../data/supabase'

interface AuthState {
  session: Session | null
  ready: boolean
}

export const useAuth = create<AuthState>(() => ({ session: null, ready: !supabaseConfigured }))

export function initAuth() {
  if (!supabaseConfigured) return
  supabase.auth.getSession().then(({ data }) => {
    useAuth.setState({ session: data.session, ready: true })
    if (data.session) void sync.start(data.session)
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    useAuth.setState({ session, ready: true })
    if (session) void sync.start(session)
    else void sync.stop()
  })
}

export async function signOut() {
  await sync.pushNow()
  await supabase.auth.signOut()
  // Notes stay in the cloud; the device copy is removed so the next account starts clean.
  await clearLocalData()
}
