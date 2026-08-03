import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export function writeFileContentAtomically(filePath: string, content: string): void {
  let writePath = filePath
  let fileIsSymbolicLink = false
  try {
    fileIsSymbolicLink = lstatSync(filePath).isSymbolicLink()
  } catch (error) {
    if (existsSync(filePath)) throw error
  }
  if (fileIsSymbolicLink) writePath = realpathSync(filePath)
  mkdirSync(path.dirname(writePath), { recursive: true })
  const mode = existsSync(writePath) ? statSync(writePath).mode & 0o777 : 0o600
  const temporaryPath = path.join(
    path.dirname(writePath),
    `.${path.basename(writePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  const descriptor = openSync(temporaryPath, 'wx', mode)
  let closed = false
  try {
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    closed = true
    renameSync(temporaryPath, writePath)
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
