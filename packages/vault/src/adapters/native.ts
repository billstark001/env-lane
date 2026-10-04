import { EnvLaneError } from '@env-lane/core'
import native from '@env-lane/native'

interface NativeResponse<T> {
  ok: boolean
  result?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

export function callNativeVault<T>(operation: string, request: Record<string, unknown>): T {
  const response = JSON.parse(
    native.invoke(operation, JSON.stringify(request)),
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
