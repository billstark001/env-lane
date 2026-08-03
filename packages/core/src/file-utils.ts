import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export function writeFileContentAtomically(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  const descriptor = openSync(temporaryPath, 'wx', mode)
  let closed = false
  try {
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    closed = true
    renameSync(temporaryPath, filePath)
  } catch (error) {
    if (!closed) {
      try {
        closeSync(descriptor)
      } catch {}
    }
    try {
      unlinkSync(temporaryPath)
    } catch {}
    throw error
  }
}
