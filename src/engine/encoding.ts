/**
 * Compact wire format for stroke points: "1:" + base64(Int16[x*8, y*8, p*32767, ...]).
 * 1/8 unit precision over a ±4095 unit range, ~8 base64 chars per point.
 */
const SCALE = 8
const LIMIT = 32767

function clamp16(v: number): number {
  return Math.max(-LIMIT, Math.min(LIMIT, Math.round(v)))
}

export function encodePoints(points: number[]): string {
  const arr = new Int16Array(points.length)
  for (let i = 0; i < points.length; i += 3) {
    arr[i] = clamp16(points[i] * SCALE)
    arr[i + 1] = clamp16(points[i + 1] * SCALE)
    arr[i + 2] = clamp16(points[i + 2] * LIMIT)
  }
  const bytes = new Uint8Array(arr.buffer)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return '1:' + btoa(bin)
}

export function decodePoints(encoded: string): number[] {
  if (!encoded.startsWith('1:')) throw new Error('Unknown points encoding')
  const bin = atob(encoded.slice(2))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const arr = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const out = new Array<number>(arr.length)
  for (let i = 0; i < arr.length; i += 3) {
    out[i] = arr[i] / SCALE
    out[i + 1] = arr[i + 1] / SCALE
    out[i + 2] = arr[i + 2] / LIMIT
  }
  return out
}
