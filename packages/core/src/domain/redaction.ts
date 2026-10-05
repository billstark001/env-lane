import { callNativeCore } from '../adapters/native.js'

export interface RedactOptions {
  showSecrets?: boolean
  redactionText?: string
  detectValues?: boolean
  minRedactionLength?: number
  minEntropyLength?: number
  entropyThreshold?: number
  minCharacterClasses?: number
  allowListKeys?: RegExp[]
  denyListKeys?: RegExp[]
}

export const DEFAULT_MIN_REDACTION_LENGTH = callNativeCore<number>(
  'core.redaction.defaultMinRedactionLength',
  {},
)

function nativeOptions(
  options: boolean | RedactOptions,
  key?: string,
  text?: string,
): Record<string, unknown> {
  const value: RedactOptions = typeof options === 'boolean' ? { showSecrets: options } : options
  const { allowListKeys = [], denyListKeys = [], ...scalar } = value
  if (allowListKeys.length === 0 && denyListKeys.length === 0) return scalar
  const keys = key === undefined ? [] : [key]
  if (text !== undefined) {
    keys.push(...callNativeCore<string[]>('core.redaction.inlineKeys', { value: text }))
  }
  const keyOverrides: Record<string, boolean> = Object.create(null)
  for (const candidate of keys) {
    const raw = candidate.trim()
    if (!raw) continue
    if (denyListKeys.some((pattern) => testPattern(pattern, raw))) keyOverrides[raw] = true
    else if (allowListKeys.some((pattern) => testPattern(pattern, raw))) keyOverrides[raw] = false
  }
  return { ...scalar, keyOverrides }
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}

function classify(
  operation: string,
  request: { key?: string; value?: string; options?: boolean | RedactOptions },
): boolean {
  return callNativeCore<boolean>(`core.redaction.${operation}`, {
    ...request,
    options: nativeOptions(
      request.options ?? {},
      request.key,
      operation === 'isSecretLikeValue' || operation === 'shouldRedact' ? request.value : undefined,
    ),
  })
}

/** Native detection is shared with the Rust CLI and Vault previews. */
export function isSecretLikeKey(key: string, options: RedactOptions = {}): boolean {
  return classify('isSecretLikeKey', { key, options })
}

export function isSecretLikeValue(value: string, options: RedactOptions = {}): boolean {
  return classify('isSecretLikeValue', { value, options })
}

export function isJwt(value: string): boolean {
  return classify('isJwt', { value })
}

export function isPaseto(value: string): boolean {
  return classify('isPaseto', { value })
}

export function isHighEntropyString(value: string, options: RedactOptions = {}): boolean {
  return classify('isHighEntropyString', { value, options })
}

export function shouldRedact(
  key: string,
  value: string,
  options: boolean | RedactOptions = false,
): boolean {
  return classify('shouldRedact', { key, value, options })
}

export function redactValue(key: string, value: string, showSecrets?: boolean): string
export function redactValue(key: string, value: string, options?: RedactOptions): string
export function redactValue(
  key: string,
  value: string,
  options: boolean | RedactOptions = false,
): string {
  return callNativeCore<string>('core.redaction.redactValue', {
    key,
    value,
    options: nativeOptions(options, key, value),
  })
}

/** Preserve the JavaScript record shape while classifying each value in Rust. */
export function redactRecord(
  values: Record<string, string>,
  showSecrets?: boolean,
): Record<string, string>
export function redactRecord(
  values: Record<string, string>,
  options?: RedactOptions,
): Record<string, string>
export function redactRecord(
  values: Record<string, string>,
  options: boolean | RedactOptions = false,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      redactValue(key, value, options as RedactOptions),
    ]),
  )
}

/** Copy enumerable fields for display; cycles become `[Circular]`, shared references are copied. */
export function redactObject<T>(value: T, options: boolean | RedactOptions = false): T {
  const showSecrets = typeof options === 'boolean' ? options : options.showSecrets
  const redactionText = typeof options === 'boolean' ? undefined : options.redactionText
  const marker = redactionText ?? '<redacted>'
  const seen = new WeakSet<object>()

  function visit(input: unknown, key = ''): unknown {
    if (showSecrets) return input
    if (typeof input === 'string') return redactValue(key, input, options as RedactOptions)
    if (input == null || typeof input !== 'object') return input
    if (key && isSecretLikeKey(key, typeof options === 'boolean' ? {} : options)) return marker
    if (seen.has(input)) return '[Circular]'
    seen.add(input)
    try {
      if (Array.isArray(input)) return input.map((item) => visit(item, key))
      return Object.fromEntries(
        Object.entries(input).map(([childKey, childValue]) => [
          childKey,
          visit(childValue, childKey),
        ]),
      )
    } finally {
      seen.delete(input)
    }
  }

  return visit(value) as T
}
