import path from 'node:path'

type PathFlavor = Pick<typeof path, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>

function assertPortableRelativePath(value: string): void {
  if (!value || value.includes('\0')) throw new Error('Vault record has an invalid file path.')
  if (
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error('Vault version 1 record file paths must be portable relative paths.')
  }
}

export function encodeVaultRecordPath(
  baseDir: string,
  filePath: string,
  pathFlavor: PathFlavor = path,
): string {
  const relativePath = pathFlavor.relative(baseDir, filePath) || '.'
  const portablePath =
    pathFlavor.sep === '\\' ? relativePath.replaceAll(pathFlavor.sep, '/') : relativePath
  assertPortableRelativePath(portablePath)
  return portablePath
}

export function resolveVaultRecordPath(
  baseDir: string,
  storedPath: string,
  pathFlavor: PathFlavor = path,
): string {
  assertPortableRelativePath(storedPath)
  return pathFlavor.resolve(baseDir, ...storedPath.split('/'))
}
