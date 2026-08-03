export class EnvLaneError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'EnvLaneError'
    this.code = code
    this.details = details
  }
}

export function errorCode(error: unknown): string {
  return error instanceof EnvLaneError ? error.code : 'ENV_LANE_ERROR'
}
