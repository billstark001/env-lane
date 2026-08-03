import { existsSync, readFileSync } from 'node:fs'
import { parse as parseDotenv } from 'dotenv'
import { writeFileContentAtomically } from './file-utils.js'

export interface EnvTextDocument {
  hasBom: boolean
  eol: string
  hasFinalNewline: boolean
  lines: string[]
}

export type EnvLineData =
  | { kind: 'empty' | 'comment'; rawLine: string }
  | { kind: 'continuation'; rawLine: string; entryLineNumber: number }
  | {
      kind: 'entry'
      rawLine: string
      key: string
      prefix: string
      separator: '=' | ':'
      valueToken: string
      suffix: string
      effectiveValue: string
    }
  | {
      kind: 'commented-entry'
      rawLine: string
      key: string
      prefix: string
      activePrefix: string
      separator: '=' | ':'
      valueToken: string
      suffix: string
      effectiveValue: string
    }
  | { kind: 'invalid'; rawLine: string; reason: string }

export type EnvLine = EnvLineData & { lineNumber: number }

export interface LoadedEnvDocument {
  exists: boolean
  document: EnvTextDocument
  parsedLines: EnvLine[]
  currentMap: Map<string, { effectiveValue: string; lineNumber?: number }>
  occurrencesMap: Map<string, Array<{ effectiveValue: string; prefix: string; lineNumber: number }>>
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

const ENV_ENTRY_PREFIX_RE =
  /^(\s*(?:export\s+)?([\w.-]+)\s*(=)\s*|\s*(?:export\s+)?([\w.-]+)\s*(:)\s+)/
const COMMENT_PREFIX_RE = /^(\s*#\s*)(.*)$/

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

function splitValueAndSuffix(raw: string): { valueToken: string; suffix: string } {
  const opening = raw[0]
  const quote = opening === "'" || opening === '"' || opening === '`' ? opening : undefined
  let quoteClosed = quote === undefined
  for (let index = 0; index < raw.length; index++) {
    if (!quoteClosed && quote) {
      if (index === 0 || raw[index] !== quote) continue
      if (!isEscapedAt(raw, index)) quoteClosed = true
      continue
    }
    if (raw[index] === '#') {
      const beforeComment = raw.slice(0, index)
      const valueToken = beforeComment.trimEnd()
      return { valueToken, suffix: `${beforeComment.slice(valueToken.length)}${raw.slice(index)}` }
    }
  }
  const valueToken = raw.trimEnd()
  return { valueToken, suffix: raw.slice(valueToken.length) }
}

function isEscapedAt(value: string, index: number): boolean {
  let precedingBackslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1
  }
  return precedingBackslashes % 2 === 1
}

function parseActiveEnvEntry(line: string): Extract<EnvLineData, { kind: 'entry' }> | undefined {
  const match = line.match(ENV_ENTRY_PREFIX_RE)
  if (!match) return undefined
  const key = match[2] ?? match[4]
  const separator = (match[3] ?? match[5]) as '=' | ':'
  const parsed = parseDotenv(line)
  if (!Object.hasOwn(parsed, key)) return undefined
  const prefix = match[1]
  const { valueToken, suffix } = splitValueAndSuffix(line.slice(prefix.length))
  return {
    kind: 'entry',
    rawLine: line,
    key,
    prefix,
    separator,
    valueToken,
    suffix,
    effectiveValue: parsed[key],
  }
}

export function parseEnvLine(line: string): EnvLineData {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty', rawLine: line }
  if (trimmed.startsWith('#')) {
    const commentMatch = line.match(COMMENT_PREFIX_RE)
    if (!commentMatch) return { kind: 'comment', rawLine: line }
    const activeEntry = parseActiveEnvEntry(commentMatch[2])
    if (!activeEntry) return { kind: 'comment', rawLine: line }
    return {
      ...activeEntry,
      kind: 'commented-entry',
      rawLine: line,
      prefix: `${commentMatch[1]}${activeEntry.prefix}`,
      activePrefix: `${commentMatch[1].match(/^\s*/)?.[0] ?? ''}${activeEntry.prefix}`,
    }
  }
  const entry = parseActiveEnvEntry(line)
  if (entry) return entry
  return { kind: 'invalid', rawLine: line, reason: 'not valid dotenv assignment syntax' }
}

export function isEnvEntryLine(
  line: EnvLine,
): line is EnvLine & Extract<EnvLineData, { kind: 'entry' }> {
  return line.kind === 'entry'
}

export function isEnvEntryLikeLine(line: EnvLine): line is EnvLine & {
  kind: 'entry' | 'commented-entry'
  key: string
  valueToken: string
  effectiveValue: string
  prefix: string
  suffix: string
  separator: '=' | ':'
} {
  return line.kind === 'entry' || line.kind === 'commented-entry'
}

function markMultilineContinuations(parsedLines: EnvLine[]): void {
  for (let index = 0; index < parsedLines.length; index++) {
    const line = parsedLines[index]
    if (line.kind !== 'entry') continue
    const token = line.valueToken.trimStart()
    const quote = token[0]
    if (quote !== "'" && quote !== '"' && quote !== '`') continue
    let closed = false
    for (let cursor = 1; cursor < token.length; cursor++) {
      if (token[cursor] !== quote) continue
      if (!isEscapedAt(token, cursor)) {
        closed = true
        break
      }
    }
    if (closed) continue
    let closingLineIndex: number | undefined
    for (let cursor = index + 1; cursor < parsedLines.length; cursor++) {
      const candidate = parsedLines[cursor]
      for (let charIndex = 0; charIndex < candidate.rawLine.length; charIndex++) {
        if (candidate.rawLine[charIndex] !== quote) continue
        if (!isEscapedAt(candidate.rawLine, charIndex)) {
          closingLineIndex = cursor
          break
        }
      }
      if (closingLineIndex !== undefined) break
    }
    if (closingLineIndex === undefined) continue
    for (let cursor = index + 1; cursor <= closingLineIndex; cursor++) {
      const continuation = parsedLines[cursor]
      parsedLines[cursor] = {
        kind: 'continuation',
        rawLine: continuation.rawLine,
        lineNumber: continuation.lineNumber,
        entryLineNumber: line.lineNumber,
      }
    }
    index = closingLineIndex
  }
}

function collectEnvEntries(parsedLines: EnvLine[]): {
  currentMap: LoadedEnvDocument['currentMap']
  occurrencesMap: LoadedEnvDocument['occurrencesMap']
  invalidLineCount: number
  shadowedEntryCount: number
} {
  const currentMap = new Map<string, { effectiveValue: string; lineNumber?: number }>()
  const occurrencesMap = new Map<
    string,
    Array<{ effectiveValue: string; prefix: string; lineNumber: number }>
  >()
  let invalidLineCount = 0
  let shadowedEntryCount = 0
  for (const line of parsedLines) {
    if (line.kind === 'entry') {
      const occurrences = occurrencesMap.get(line.key) ?? []
      occurrences.push({
        effectiveValue: line.effectiveValue,
        prefix: line.prefix,
        lineNumber: line.lineNumber,
      })
      occurrencesMap.set(line.key, occurrences)
      if (currentMap.has(line.key)) shadowedEntryCount++
      currentMap.set(line.key, {
        effectiveValue: line.effectiveValue,
        lineNumber: line.lineNumber,
      })
    } else if (line.kind === 'invalid') {
      invalidLineCount++
    }
  }
  return { currentMap, occurrencesMap, invalidLineCount, shadowedEntryCount }
}

function applyDocumentEffectiveValues(
  content: string,
  parsedLines: EnvLine[],
  currentMap: LoadedEnvDocument['currentMap'],
  occurrencesMap: LoadedEnvDocument['occurrencesMap'],
): void {
  for (const [key, effectiveValue] of Object.entries(parseDotenv(content))) {
    const current = currentMap.get(key)
    currentMap.set(key, { effectiveValue, lineNumber: current?.lineNumber })
    const occurrences = occurrencesMap.get(key)
    if (occurrences?.length) occurrences[occurrences.length - 1].effectiveValue = effectiveValue
    const currentLine = current?.lineNumber
      ? parsedLines.find((line) => line.lineNumber === current.lineNumber)
      : undefined
    if (currentLine?.kind === 'entry') currentLine.effectiveValue = effectiveValue
  }
}

function buildParsedEnvDocument(content: string, exists: boolean): LoadedEnvDocument {
  const document = createEnvTextDocument(content)
  const parsedLines: EnvLine[] = document.lines.map((line, index) => ({
    lineNumber: index + 1,
    ...parseEnvLine(line),
  }))
  markMultilineContinuations(parsedLines)
  const { currentMap, occurrencesMap, invalidLineCount, shadowedEntryCount } =
    collectEnvEntries(parsedLines)
  applyDocumentEffectiveValues(content, parsedLines, currentMap, occurrencesMap)
  return {
    exists,
    document,
    parsedLines,
    currentMap,
    occurrencesMap,
    invalidLineCount,
    shadowedEntryCount,
  }
}

export function parseEnvDocument(content: string): LoadedEnvDocument {
  return buildParsedEnvDocument(content, true)
}

export function loadEnvDocument(filePath: string): LoadedEnvDocument {
  const fileExists = existsSync(filePath)
  return fileExists
    ? buildParsedEnvDocument(readFileSync(filePath, 'utf8'), true)
    : buildParsedEnvDocument('', false)
}

function lineKey(line: EnvLine): string | undefined {
  return isEnvEntryLikeLine(line) ? line.key : undefined
}

export function formatEnvValue(value: string): string {
  const candidates = [
    value,
    `"${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`,
    `'${value}'`,
    `\`${value}\``,
  ]
  for (const candidate of candidates) {
    if (parseDotenv(`ENV_LANE_VALUE=${candidate}`).ENV_LANE_VALUE === value) return candidate
  }
  throw new Error('Value cannot be represented by dotenv without changing its effective value.')
}

export function writeEnvDocumentContent(filePath: string, content: string): boolean {
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  if (current === content) return false
  writeFileContentAtomically(filePath, content)
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
  const replacedMultilineEntryLines = new Set<number>()
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
    if (line.kind === 'continuation' && replacedMultilineEntryLines.has(line.entryLineNumber)) {
      continue
    }
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
        replacedMultilineEntryLines.add(line.lineNumber)
        continue
      }
      nextLines.push(line.rawLine)
      continue
    }

    consumed.add(key)
    if (patch.op === 'delete') {
      deletedKeys.push(key)
      replacedMultilineEntryLines.add(line.lineNumber)
      continue
    }

    if (line.kind === 'entry' && line.effectiveValue === patch.value) {
      nextLines.push(line.rawLine)
      continue
    }
    const prefix = line.kind === 'commented-entry' ? line.activePrefix : line.prefix
    nextLines.push(`${prefix}${formatEnvValue(patch.value)}${line.suffix}`)
    replacedMultilineEntryLines.add(line.lineNumber)
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
    nextLines.push(`${patch.key}=${formatEnvValue(patch.value)}`)
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
