export const DEFAULT_ENV_FILE_VARIANT = ''
export const ALL_ENV_FILE_VARIANTS = 'all'

export type EnvFileVariant = string

export function normalizeEnvFileVariant(
  value: string | undefined,
  options: { allowAll?: boolean; fallback?: string; fieldName?: string } = {},
): EnvFileVariant {
  const fallback = options.fallback ?? DEFAULT_ENV_FILE_VARIANT
  let normalized = String(value ?? fallback).trim()
  if (!normalized) return fallback
  if (options.allowAll && normalized === ALL_ENV_FILE_VARIANTS) return ALL_ENV_FILE_VARIANTS
  if (normalized === 'default' || normalized === 'base' || normalized === 'root') {
    return DEFAULT_ENV_FILE_VARIANT
  }
  if (normalized.startsWith('.env.')) normalized = normalized.slice('.env.'.length)
  else if (normalized.startsWith('.')) normalized = normalized.slice(1)
  if (!normalized) return DEFAULT_ENV_FILE_VARIANT
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)) {
    throw new Error(
      `Invalid ${options.fieldName ?? 'env file variant'} '${value}'. Use values like production, staging, or default.`,
    )
  }
  return normalized
}

export function formatEnvFileVariant(variant: EnvFileVariant): string {
  return variant === DEFAULT_ENV_FILE_VARIANT ? 'default' : variant
}
