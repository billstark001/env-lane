import { AsyncLocalStorage } from 'node:async_hooks'

export type DiagnosticLevel = 'info' | 'warning' | 'error'
export type DiagnosticScope = 'core' | 'vault'

export interface Diagnostic {
  code: string
  level: DiagnosticLevel
  scope: DiagnosticScope
  message: string
  details?: Record<string, unknown>
}

export interface DiagnosticLogger {
  diagnostic(event: Diagnostic): void
}

export interface EnvLaneContext {
  logger: DiagnosticLogger
}

export interface DiagnosticFormatOptions {
  prefix?: boolean
}

const contextStorage = new AsyncLocalStorage<EnvLaneContext>()

export function withEnvLaneContext<T>(context: EnvLaneContext, operation: () => T): T {
  return contextStorage.run(context, operation)
}

export function emitDiagnostic(event: Diagnostic): void {
  contextStorage.getStore()?.logger.diagnostic(event)
}

export function formatDiagnostic(event: Diagnostic, options: DiagnosticFormatOptions = {}): string {
  const scope = event.scope === 'vault' ? 'env-lane:vault' : 'env-lane'
  const prefix = options.prefix === false ? '' : `[${scope}] `
  return event.message
    .split('\n')
    .map((line) => `${prefix}${event.level} ${event.code}: ${line}`)
    .join('\n')
}
