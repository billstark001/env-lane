import { callNativeCore } from '../adapters/native.js'

export const DEFAULT_ENV_FILE_VARIANT = ''
export const ALL_ENV_FILE_VARIANTS = 'all'

export type EnvFileVariant = string

export function normalizeEnvFileVariant(
  value: string | undefined,
  options: { allowAll?: boolean; fallback?: string; fieldName?: string } = {},
): EnvFileVariant {
  return callNativeCore<EnvFileVariant>('core.normalizeEnvFileVariant', {
    value,
    fallback: options.fallback ?? DEFAULT_ENV_FILE_VARIANT,
    allowAll: options.allowAll,
    fieldName: options.fieldName,
  })
}

export function formatEnvFileVariant(variant: EnvFileVariant): string {
  return variant === DEFAULT_ENV_FILE_VARIANT ? 'default' : variant
}
