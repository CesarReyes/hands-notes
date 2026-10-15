/**
 * Monotonic LWW timestamps. Never goes backwards and always beats any remote
 * timestamp already seen, so a device with a slow clock can still win edits.
 */
let last = 0

export function nextTimestamp(): number {
  last = Math.max(Date.now(), last + 1)
  return last
}

export function observeTimestamp(ts: number) {
  if (ts > last) last = ts
}
