import {
  DEFAULT_MIN_REDACTION_LENGTH,
  isHighEntropyString,
  isSecretLikeKey,
  isSecretLikeValue,
} from '@env-lane/core'
import type { VaultRestoreRedaction, VaultRestoreReveal } from './types.js'

const REDACTION_TEXT = '<redacted>'
const CREDENTIAL_QUERY_KEY_RE =
  /^(?:_?token|access_?token|id_?token|refresh_?token|api_?key|key|secret|password|passwd|pwd|signature|sig|client_secret)$/i

function redactionText(value: string, reveal: VaultRestoreReveal | false): string {
  if (value.trim().length < DEFAULT_MIN_REDACTION_LENGTH) return value
  if (!reveal || reveal.start + reveal.end === 0 || value.length <= reveal.start + reveal.end) {
    return REDACTION_TEXT
  }
  const start = reveal.start > 0 ? value.slice(0, reveal.start) : ''
  const end = reveal.end > 0 ? value.slice(-reveal.end) : ''
  return `<redacted:${start}......${end}>`
}

function safeDecodeComponent(value: string, query = false): string {
  try {
    return decodeURIComponent(query ? value.replaceAll('+', ' ') : value)
  } catch {
    return value
  }
}

function isOpaqueComponent(value: string): boolean {
  if (value.trim().length < DEFAULT_MIN_REDACTION_LENGTH) return false
  return (
    isSecretLikeKey(value) ||
    isSecretLikeValue(value) ||
    isHighEntropyString(value, {
      minEntropyLength: 16,
      entropyThreshold: 3.5,
      minCharacterClasses: 2,
    })
  )
}

function authorityEnd(value: string, authorityStart: number): number {
  const candidates = [
    value.indexOf('/', authorityStart),
    value.indexOf('?', authorityStart),
    value.indexOf('#', authorityStart),
  ].filter((index) => index !== -1)
  return candidates.length > 0 ? Math.min(...candidates) : value.length
}

function redactUrlCredentials(
  value: string,
  parsed: URL,
  reveal: VaultRestoreReveal | false,
): { value: string; changed: boolean } {
  if (!parsed.username && !parsed.password) return { value, changed: false }

  const schemeEnd = value.indexOf('://')
  if (schemeEnd === -1) return { value: redactionText(value, reveal), changed: true }
  const start = schemeEnd + 3
  const end = authorityEnd(value, start)
  const authority = value.slice(start, end)
  const at = authority.lastIndexOf('@')
  if (at === -1) return { value: redactionText(value, reveal), changed: true }
  const credentials = authority.slice(0, at)
  if (safeDecodeComponent(credentials).trim().length < DEFAULT_MIN_REDACTION_LENGTH) {
    return { value, changed: false }
  }

  return {
    value: `${value.slice(0, start)}${redactionText(credentials, reveal)}@${authority.slice(at + 1)}${value.slice(end)}`,
    changed: true,
  }
}

function redactUrlQuery(
  value: string,
  reveal: VaultRestoreReveal | false,
): { value: string; changed: boolean } {
  const queryStart = value.indexOf('?')
  if (queryStart === -1) return { value, changed: false }
  const fragmentStart = value.indexOf('#', queryStart)
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart
  let changed = false
  const query = value
    .slice(queryStart + 1, queryEnd)
    .split('&')
    .map((part) => {
      const equals = part.indexOf('=')
      const rawKey = equals === -1 ? part : part.slice(0, equals)
      const rawValue = equals === -1 ? '' : part.slice(equals + 1)
      const credentialKey = CREDENTIAL_QUERY_KEY_RE.test(safeDecodeComponent(rawKey, true))
      const decodedValue = safeDecodeComponent(rawValue, true)
      if (decodedValue.trim().length < DEFAULT_MIN_REDACTION_LENGTH) return part
      if (!credentialKey && !isOpaqueComponent(decodedValue)) return part
      changed = true
      return `${rawKey}=${redactionText(rawValue, reveal)}`
    })
    .join('&')

  return {
    value: `${value.slice(0, queryStart + 1)}${query}${value.slice(queryEnd)}`,
    changed,
  }
}

function redactUrlPath(
  value: string,
  reveal: VaultRestoreReveal | false,
): { value: string; changed: boolean } {
  const schemeEnd = value.indexOf('://')
  if (schemeEnd === -1) return { value: redactionText(value, reveal), changed: true }
  const start = schemeEnd + 3
  const pathStart = value.indexOf('/', start)
  if (pathStart === -1) return { value, changed: false }
  const queryStart = value.indexOf('?', pathStart)
  const fragmentStart = value.indexOf('#', pathStart)
  const candidates = [queryStart, fragmentStart].filter((index) => index !== -1)
  const pathEnd = candidates.length > 0 ? Math.min(...candidates) : value.length
  const pathname = value.slice(pathStart, pathEnd)
  const segments = pathname.split('/')
  let changed = false
  const redactedPath = segments
    .map((segment) => {
      if (!segment) return segment
      const decoded = safeDecodeComponent(segment)
      if (!isOpaqueComponent(decoded)) return segment
      changed = true
      return redactionText(segment, reveal)
    })
    .join('/')

  return {
    value: `${value.slice(0, pathStart)}${redactedPath}${value.slice(pathEnd)}`,
    changed,
  }
}

export function restoreValuePreview(
  key: string,
  value: string,
  redaction: VaultRestoreRedaction,
  reveal: VaultRestoreReveal | false = false,
): string {
  if (redaction === 'full') return redactionText(value, reveal)
  if (redaction === 'none') return value

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return isSecretLikeKey(key) || isOpaqueComponent(value) ? redactionText(value, reveal) : value
  }

  const credentials = redactUrlCredentials(value, parsed, reveal)
  const query = redactUrlQuery(credentials.value, reveal)
  return redactUrlPath(query.value, reveal).value
}

export function restoreCurrentPreview(
  key: string,
  values: readonly string[],
  redaction: VaultRestoreRedaction,
  reveal: VaultRestoreReveal | false = false,
): string {
  if (values.length === 0) return '<missing>'
  if (
    redaction === 'full' &&
    !reveal &&
    values.every((value) => value.trim().length >= DEFAULT_MIN_REDACTION_LENGTH)
  ) {
    return REDACTION_TEXT
  }
  const previews = values.map((value) => restoreValuePreview(key, value, redaction, reveal))
  return previews.length === 1 ? previews[0] : JSON.stringify(previews)
}
