import native from '@env-lane/native'
import { EnvLaneError } from '../domain/errors.js'
import { emitDiagnostic } from './logger.js'

interface NativeResponse<T> {
  ok: boolean
  result?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

interface NativeDiagnostic {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
  details?: Record<string, unknown>
}

export function callNative<T>(operation: string, request: Record<string, unknown>): T {
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

export function callNativeCore<T>(operation: string, request: Record<string, unknown>): T {
  const result = callNative<{ value: T; diagnostics: NativeDiagnostic[] }>(operation, request)
  for (const event of result.diagnostics) {
    emitDiagnostic({
      code: event.code,
      level: event.severity === 'warn' ? 'warning' : event.severity,
      scope: 'core',
      message: event.message,
      details: event.details,
    })
  }
  return result.value
}
