import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvLaneError } from '@env-lane/core'
import native from '@env-lane/native'

interface NativeResponse<T> {
  ok: boolean
  result?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

let vaultExecutable: string | undefined
function pluginExecutable(): string {
  if (vaultExecutable) return vaultExecutable
  const name = process.platform === 'win32' ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
  let directory = dirname(
    typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url),
  )
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@env-lane/vault') {
          const executable = join(directory, 'dist', name)
          if (existsSync(executable)) {
            vaultExecutable = executable
            return executable
          }
          break
        }
      } catch {
        /* Continue to the next package boundary. */
      }
    }
    directory = dirname(directory)
  }
  throw new EnvLaneError('VAULT_NOT_INSTALLED', 'The native Vault plugin executable is missing.')
}

export function callNativeVault<T>(operation: string, request: Record<string, unknown>): T {
  const response = JSON.parse(
    native.invoke(operation, JSON.stringify({ ...request, pluginExecutable: pluginExecutable() })),
  ) as NativeResponse<T>
  if (!response.ok) {
    const error = response.error
    throw new EnvLaneError(
      error?.code ?? 'ENV_LANE_ERROR',
      error?.message ?? 'Native operation failed.',
      error?.details,
    )
  }
  return response.result as T
}
