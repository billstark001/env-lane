import { existsSync, readFileSync } from 'node:fs'
import { writeFileContentAtomically } from '../adapters/file-utils.js'
import { callNativeCore } from '../adapters/native.js'

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

interface NativeParsedDocument {
  document: EnvTextDocument
  parsedLines: EnvLine[]
  currentEntries: Array<[string, { effectiveValue: string; lineNumber?: number }]>
  occurrenceEntries: Array<
    [string, Array<{ effectiveValue: string; prefix: string; lineNumber: number }>]
  >
  invalidLineCount: number
  shadowedEntryCount: number
}

interface NativePatchResult {
  content: string
  changed: boolean
  writtenKeys: string[]
  addedKeys: string[]
  deletedKeys: string[]
  removedDuplicateKeys: string[]
  restoredCommentedKeys: string[]
}

/** Split dotenv text into physical lines while retaining its BOM and line endings. */
export function createEnvTextDocument(content: string): EnvTextDocument {
  return callNativeCore('core.envDocument.create', { content })
}

/** Render physical lines using the original document's newline policy by default. */
export function renderEnvTextDocument(
  document: EnvTextDocument,
  lines: string[],
  options: { preserveBOM?: boolean; eol?: 'auto' | 'lf' | 'crlf' } = {},
): string {
  return callNativeCore('core.envDocument.render', { document, lines, ...options })
}

/** Classify one physical dotenv line without assigning it a document line number. */
export function parseEnvLine(line: string): EnvLineData {
  const { lineNumber: _lineNumber, ...parsed } = callNativeCore<EnvLine>(
    'core.envDocument.parseLine',
    { line },
  )
  return parsed as EnvLineData
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

function parsedDocument(content: string, exists: boolean): LoadedEnvDocument {
  const parsed = callNativeCore<NativeParsedDocument>('core.envDocument.parse', { content })
  return {
    exists,
    document: parsed.document,
    parsedLines: parsed.parsedLines,
    currentMap: new Map(parsed.currentEntries),
    occurrencesMap: new Map(parsed.occurrenceEntries),
    invalidLineCount: parsed.invalidLineCount,
    shadowedEntryCount: parsed.shadowedEntryCount,
  }
}

/** Parse effective values and editable physical lines from a dotenv document. */
export function parseEnvDocument(content: string): LoadedEnvDocument {
  return parsedDocument(content, true)
}

/** Read an existing dotenv file, or return the shape of a missing empty file. */
export function loadEnvDocument(filePath: string): LoadedEnvDocument {
  const exists = existsSync(filePath)
  return parsedDocument(exists ? readFileSync(filePath, 'utf8') : '', exists)
}

/** Choose a dotenv spelling that preserves the supplied effective value. */
export function formatEnvValue(value: string): string {
  return callNativeCore('core.envDocument.formatValue', { value })
}

/** Write only when the destination's current UTF-8 content differs. */
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

/** Apply line-preserving edits using the native document model. */
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
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  // Map keeps the first key position and the last requested operation, as the
  // established JS patch API does. Locale collation remains at this boundary.
  const desired = [...new Map([...patches].map((patch) => [patch.key, patch])).values()]
  if (options.sortAdditions) desired.sort((left, right) => left.key.localeCompare(right.key))
  const result = callNativeCore<NativePatchResult>('core.envDocument.patch', {
    content,
    patches: desired,
    options: { ...options, ignoredKeys: [...(options.ignoredKeys ?? [])] },
  })
  const changed = result.changed && writeEnvDocumentContent(filePath, result.content)
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
    changed,
    filePath,
    writtenKeys: result.writtenKeys,
    addedKeys: result.addedKeys,
    deletedKeys: result.deletedKeys,
    removedDuplicateKeys: result.removedDuplicateKeys,
    restoredCommentedKeys: result.restoredCommentedKeys,
  }
}

/** Set values at their last occurrence, removing earlier active duplicates. */
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
