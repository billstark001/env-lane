import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EnvLaneError } from '@env-lane/core'

const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

interface LockMetadata {
  pid: number
  createdAt: number
  token: string
}

function isLockMetadata(value: unknown): value is LockMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<LockMetadata>
  return (
    Number.isInteger(metadata.pid) &&
    Number.isFinite(metadata.createdAt) &&
    typeof metadata.token === 'string' &&
    metadata.token.length > 0
  )
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as unknown
    return isLockMetadata(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

export async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath)
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_MS) return
    const metadata = await readLockMetadata(lockPath)
    if (metadata && processIsAlive(metadata.pid)) return
    const currentStat = await stat(lockPath)
    if (currentStat.ino === lockStat.ino && currentStat.mtimeMs === lockStat.mtimeMs) {
      await unlink(lockPath)
    }
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
  let token: string | undefined

  while (!handle) {
    try {
      const openedHandle = await open(lockPath, 'wx', 0o600)
      const nextToken = randomUUID()
      try {
        await openedHandle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: nextToken })}\n`,
        )
      } catch (error) {
        await openedHandle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
        throw error
      }
      handle = openedHandle
      token = nextToken
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
    const metadata = await readLockMetadata(lockPath)
    if (metadata?.token === token) await unlink(lockPath).catch(() => undefined)
  }
}
