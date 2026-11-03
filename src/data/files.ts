import { db } from './db'
import { uuidv7 } from './ids'
import { sync } from './sync'
import { localChanges } from './repo'

/** PDF bytes for an imported file: the local copy, else a one-time download from Storage. */
export async function loadFileBytes(fileId: string): Promise<ArrayBuffer> {
  const local = await db.files.get(fileId)
  if (local) return local.data
  return sync.downloadFile(fileId)
}

/** Image bytes and type, from the local copy or Storage. */
export async function loadImageFile(fileId: string): Promise<{ data: ArrayBuffer; type: string }> {
  let local = await db.files.get(fileId)
  if (!local) {
    await sync.downloadFile(fileId, 'image/jpeg')
    local = await db.files.get(fileId)
  }
  if (!local) throw new Error('Image not found')
  return { data: local.data, type: local.type ?? 'image/jpeg' }
}

/** Stores a prepared image locally (sync uploads it) and returns its file id. */
export async function saveImageFile(data: ArrayBuffer, type: string): Promise<string> {
  const id = uuidv7()
  await db.files.add({ id, type, data, size: data.byteLength, dirty: 1 })
  localChanges.dispatchEvent(new Event('change'))
  return id
}
