import path from 'node:path'

declare const absolutePathBrand: unique symbol

export type AbsolutePath = string & { readonly [absolutePathBrand]: true }

export function resolveInvocationCwd(cwd?: string): AbsolutePath {
  return path.resolve(cwd ?? process.cwd()) as AbsolutePath
}

export function resolveFromDirectory(directory: AbsolutePath, value: string): AbsolutePath {
  return path.resolve(directory, value) as AbsolutePath
}

export function absoluteDirname(value: AbsolutePath): AbsolutePath {
  return path.dirname(value) as AbsolutePath
}

export function assertAbsolutePath(
  value: string,
  fieldName: string,
): asserts value is AbsolutePath {
  if (!path.isAbsolute(value))
    throw new TypeError(`${fieldName} must be an absolute path: ${value}`)
}
