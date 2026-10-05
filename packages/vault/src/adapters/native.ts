import { EnvLaneError, type ResolvedEnvLaneConfig } from '@env-lane/core'
import native from '@env-lane/native'

interface NativeResponse<T> {
  ok: boolean
  result?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

const hostConfigs = new WeakMap<object, ResolvedEnvLaneConfig>()

export function bindVaultHostConfig(config: object, hostConfig: ResolvedEnvLaneConfig): void {
  hostConfigs.set(config, hostConfig)
}

export function callNativeVault<T>(operation: string, request: Record<string, unknown>): T {
  const config = request.config
  const hostConfig: ResolvedEnvLaneConfig | undefined =
    (request.hostConfig as ResolvedEnvLaneConfig | undefined) ??
    (config && typeof config === 'object' ? hostConfigs.get(config) : undefined)
  const response = JSON.parse(
    native.invoke(
      operation,
      JSON.stringify({
        ...request,
        hostConfig,
        projectRoot: request.projectRoot ?? hostConfig?.rootDir,
      }),
    ),
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
