import { type FileHandle, mkdir, open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EnvLaneError } from '@env-lane/core'

const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath)
    if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) await unlink(lockPath)
  } catch {
    // The lock disappeared between attempts.
  }
}

export async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lockPath = `${path.resolve(targetPath)}.lock`
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle: FileHandle | undefined

  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      await removeStaleLock(lockPath)
      if (Date.now() >= deadline) {
        throw new EnvLaneError(
          'VAULT_LOCK_TIMEOUT',
          `Timed out waiting for Vault lock: ${lockPath}`,
        )
      }
      await delay(10)
    }
  }

  try {
    return await operation()
  } finally {
    await handle.close()
    await unlink(lockPath).catch(() => undefined)
  }
}
