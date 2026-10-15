/**
 * UUIDv7: time-ordered, so sorting stroke ids gives creation (z) order
 * on every device without an extra column.
 */
let lastMs = 0
let seq = 0

export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff
    if (seq === 0) lastMs++
    now = lastMs
  } else {
    lastMs = now
    seq = crypto.getRandomValues(new Uint16Array(1))[0] & 0x3ff
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const ms = BigInt(now)
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f)
  bytes[7] = seq & 0xff
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
