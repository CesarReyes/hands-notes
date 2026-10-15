import { useSyncStatus } from '../data/sync'
import { IconCheck, IconCloud, IconCloudOff } from './icons'

const LABELS = {
  'signed-out': 'Solo en este dispositivo',
  offline: 'Sin conexión',
  syncing: 'Sincronizando…',
  synced: 'Sincronizado',
  error: 'Error de sincronización',
} as const

export function SyncBadge({ onClick, compact }: { onClick?(): void; compact?: boolean }) {
  const { state, pending, error } = useSyncStatus()
  const icon = state === 'synced' ? <IconCheck size={16} /> : state === 'offline' || state === 'signed-out' || state === 'error' ? <IconCloudOff size={16} /> : <IconCloud size={16} />
  const label = state === 'offline' && pending ? `Sin conexión · ${pending} pendientes` : LABELS[state]
  return (
    <button className={`sync-badge state-${state}`} onClick={onClick} title={error ?? label} aria-label={label}>
      {icon}
      {!compact && <span>{label}</span>}
    </button>
  )
}
