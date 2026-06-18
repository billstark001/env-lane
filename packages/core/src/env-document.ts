import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface EnvTextDocument {
  hasBom: boolean
  eol: string
  hasFinalNewline: boolean
  lines: string[]
}

export type EnvLineData =
  | { kind: 'empty' | 'comment'; rawLine: string }
  | {
      kind: 'entry' | 'commented-entry'
      rawLine: string
      key: string
      prefix: string
      rawValue: string
    }
  | { kind: 'invalid'; rawLine: string; reason: string }

export type EnvLine = EnvLineData & { lineNumber: number }

export interface LoadedEnvDocument {
  exists: boolean
  document: EnvTextDocument
  parsedLines: EnvLine[]
  currentMap: Map<string, { value: string }>
  occurrencesMap: Map<string, Array<{ value: string; prefix: string; lineNumber: number }>>
  invalidLineCount: number
  shadowedEntryCount: number
}

export interface EnvDocumentWriteResult {
  changed: boolean
  filePath: string
  writtenKeys: string[]
  removedDuplicateKeys: string[]
  restoredCommentedKeys: string[]
}

export type EnvDocumentPatch =
  | { op: 'set'; key: string; value: string }
  | { op: 'delete'; key: string }

export interface EnvDocumentPatchResult extends EnvDocumentWriteResult {
  addedKeys: string[]
  deletedKeys: string[]
}

const ENV_ENTRY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const COMMENTED_ENV_ENTRY_RE = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

export function createEmptyEnvDocument(): EnvTextDocument {
  return { hasBom: false, eol: '\n', hasFinalNewline: true, lines: [] }
}

export function createEnvTextDocument(content: string): EnvTextDocument {
  const hasBom = content.startsWith('\uFEFF')
  const raw = hasBom ? content.slice(1) : content
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = raw.length > 0 && /\r?\n$/.test(raw)
  let lines = raw.length > 0 ? raw.split(/\r\n|\n/) : []
  if (hasFinalNewline && lines.at(-1) === '') lines = lines.slice(0, -1)
  return { hasBom, eol, hasFinalNewline, lines }
}

export function renderEnvTextDocument(
  document: EnvTextDocument,
  lines: string[],
  options: { preserveBOM?: boolean; eol?: 'auto' | 'lf' | 'crlf' } = {},
): string {
  const finalEol = options.eol === 'lf' ? '\n' : options.eol === 'crlf' ? '\r\n' : document.eol
  const body = lines.join(finalEol)
  const withNewline = lines.length > 0 && document.hasFinalNewline ? `${body}${finalEol}` : body
  const keepBom = (options.preserveBOM ?? true) && document.hasBom
  return keepBom ? `\uFEFF${withNewline}` : withNewline
}

export function parseEnvLine(line: string): EnvLineData {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty', rawLine: line }
  if (trimmed.startsWith('#')) {
    const commentedEntryMatch = line.match(COMMENTED_ENV_ENTRY_RE)
    if (commentedEntryMatch) {
      const eqIdx = line.indexOf('=')
      return {
        kind: 'commented-entry',
        rawLine: line,
        key: commentedEntryMatch[1],
        prefix: line.slice(0, eqIdx + 1),
        rawValue: line.slice(eqIdx + 1),
      }
    }
    return { kind: 'comment', rawLine: line }
  }
  const eqIdx = line.indexOf('=')
  if (eqIdx < 0) return { kind: 'invalid', rawLine: line, reason: 'missing equals sign' }
  const match = line.match(ENV_ENTRY_RE)
  if (!match) return { kind: 'invalid', rawLine: line, reason: 'invalid env key' }
  return {
    kind: 'entry',
    rawLine: line,
    key: match[1],
    prefix: line.slice(0, eqIdx + 1),
    rawValue: line.slice(eqIdx + 1),
  }
}

export function isEnvEntryLine(
  line: EnvLine,
): line is EnvLine & { kind: 'entry'; key: string; rawValue: string; prefix: string } {
  return line.kind === 'entry'
}

export function isEnvEntryLikeLine(line: EnvLine): line is EnvLine & {
  kind: 'entry' | 'commented-entry'
  key: string
  rawValue: string
  prefix: string
} {
  return line.kind === 'entry' || line.kind === 'commented-entry'
}

export function loadEnvDocument(filePath: string): LoadedEnvDocument {
  const fileExists = existsSync(filePath)
  const document = fileExists
    ? createEnvTextDocument(readFileSync(filePath, 'utf8'))
    : createEmptyEnvDocument()
  const parsedLines: EnvLine[] = document.lines.map((line, index) => ({
    lineNumber: index + 1,
    ...parseEnvLine(line),
  }))
  const currentMap = new Map<string, { value: string }>()
  const occurrencesMap = new Map<
    string,
    Array<{ value: string; prefix: string; lineNumber: number }>
  >()
  let invalidLineCount = 0
  let shadowedEntryCount = 0
  for (const line of parsedLines) {
    if (line.kind === 'entry') {
      const occurrences = occurrencesMap.get(line.key) ?? []
      occurrences.push({ value: line.rawValue, prefix: line.prefix, lineNumber: line.lineNumber })
      occurrencesMap.set(line.key, occurrences)
      if (currentMap.has(line.key)) shadowedEntryCount++
      currentMap.set(line.key, { value: line.rawValue })
    } else if (line.kind === 'invalid') {
      invalidLineCount++
    }
  }
  return {
    exists: fileExists,
    document,
    parsedLines,
    currentMap,
    occurrencesMap,
    invalidLineCount,
    shadowedEntryCount,
  }
}

export function lineForEnvKey(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`)
  const idx = lines.findIndex((line) => re.test(line))
  return idx >= 0 ? idx + 1 : undefined
}

export function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lineKey(line: EnvLine): string | undefined {
  return isEnvEntryLikeLine(line) ? line.key : undefined
}

export function writeEnvDocumentContent(filePath: string, content: string): boolean {
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  if (current === content) return false
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return true
}

export function writeEnvDocumentLines(
  filePath: string,
  document: EnvTextDocument,
  lines: string[],
  options: { preserveBOM?: boolean; eol?: 'auto' | 'lf' | 'crlf' } = {},
): boolean {
  return writeEnvDocumentContent(filePath, renderEnvTextDocument(document, lines, options))
}

export function applyEnvDocumentPatches(
  filePath: string,
  patches: Iterable<EnvDocumentPatch>,
  options: {
    ignoredKeys?: Set<string>
    update?: 'all' | 'last'
    matchCommented?: boolean
    removeDuplicateEntries?: boolean
    sortAdditions?: boolean
    blankLineBeforeAdditions?: boolean
    preserveBOM?: boolean
    eol?: 'auto' | 'lf' | 'crlf'
  } = {},
): EnvDocumentPatchResult {
  const envDoc = loadEnvDocument(filePath)
  const desired = new Map([...patches].map((patch) => [patch.key, patch]))
  const update = options.update ?? 'all'
  const matchCommented = options.matchCommented ?? false
  const removeDuplicateEntries = options.removeDuplicateEntries ?? false
  const sortAdditions = options.sortAdditions ?? false
  const blankLineBeforeAdditions = options.blankLineBeforeAdditions ?? true
  const writtenKeys: string[] = []
  const addedKeys: string[] = []
  const deletedKeys: string[] = []
  const removedDuplicateKeys: string[] = []
  const restoredCommentedKeys: string[] = []
  const consumed = new Set<string>()
  const lastMatchIndex = new Map<string, number>()

  envDoc.parsedLines.forEach((line, index) => {
    const key = lineKey(line)
    if (!key || !desired.has(key)) return
    if (line.kind === 'entry' || (matchCommented && line.kind === 'commented-entry')) {
      lastMatchIndex.set(key, index)
    }
  })

  const nextLines: string[] = []
  for (const [index, line] of envDoc.parsedLines.entries()) {
    const key = lineKey(line)
    const patch = key ? desired.get(key) : undefined
    const shouldConsider =
      key &&
      patch &&
      !options.ignoredKeys?.has(key) &&
      (line.kind === 'entry' || (matchCommented && line.kind === 'commented-entry'))
    if (!shouldConsider || !key || !patch) {
      nextLines.push(line.rawLine)
      continue
    }

    const isLastMatch = index === lastMatchIndex.get(key)
    if (update === 'last' && !isLastMatch) {
      if (removeDuplicateEntries && line.kind === 'entry') {
        removedDuplicateKeys.push(key)
        continue
      }
      nextLines.push(line.rawLine)
      continue
    }

    consumed.add(key)
    if (patch.op === 'delete') {
      deletedKeys.push(key)
      continue
    }

    nextLines.push(`${line.prefix}${patch.value}`)
    writtenKeys.push(key)
    if (line.kind === 'commented-entry') restoredCommentedKeys.push(key)
  }

  let additions = [...desired.values()].filter(
    (patch): patch is Extract<EnvDocumentPatch, { op: 'set' }> =>
      patch.op === 'set' && !consumed.has(patch.key) && !options.ignoredKeys?.has(patch.key),
  )
  if (sortAdditions) additions = additions.sort((left, right) => left.key.localeCompare(right.key))
  if (
    blankLineBeforeAdditions &&
    additions.length > 0 &&
    nextLines.length > 0 &&
    nextLines.at(-1) !== ''
  )
    nextLines.push('')
  for (const patch of additions) {
    nextLines.push(`${patch.key}=${patch.value}`)
    writtenKeys.push(patch.key)
    addedKeys.push(patch.key)
  }

  const changed = writeEnvDocumentLines(filePath, envDoc.document, nextLines, {
    preserveBOM: options.preserveBOM,
    eol: options.eol,
  })
  if (!changed) {
    return {
      changed: false,
      filePath,
      writtenKeys: [],
      addedKeys: [],
      deletedKeys: [],
      removedDuplicateKeys: [],
      restoredCommentedKeys: [],
    }
  }

  return {
    changed: true,
    filePath,
    writtenKeys,
    addedKeys,
    deletedKeys,
    removedDuplicateKeys,
    restoredCommentedKeys,
  }
}

export function setEnvDocumentValues(
  filePath: string,
  values: Iterable<[string, string]>,
  options: { preserveBOM?: boolean; eol?: 'auto' | 'lf' | 'crlf' } = {},
): EnvDocumentWriteResult {
  const result = applyEnvDocumentPatches(
    filePath,
    [...values].map(([key, value]) => ({ op: 'set' as const, key, value })),
    {
      update: 'last',
      matchCommented: true,
      removeDuplicateEntries: true,
      preserveBOM: options.preserveBOM,
      eol: options.eol,
    },
  )
  return {
    changed: result.changed,
    filePath: result.filePath,
    writtenKeys: result.writtenKeys,
    removedDuplicateKeys: result.removedDuplicateKeys,
    restoredCommentedKeys: result.restoredCommentedKeys,
  }
}
