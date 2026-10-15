import { db } from './db'
import { sync } from './sync'

/** PDF bytes for an imported file: the local copy, else a one-time download from Storage. */
export async function loadFileBytes(fileId: string): Promise<ArrayBuffer> {
  const local = await db.files.get(fileId)
  if (local) return local.data
  return sync.downloadFile(fileId)
}
