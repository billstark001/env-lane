import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface EnvSortConfig {
  baseDir: string
  envFiles: string[]
  sort?: Record<string, { file: string; template: string; files?: Record<string, string> }>
}

type EnvLine =
  | { kind: 'empty' | 'comment'; rawLine: string; lineNumber: number }
  | {
      kind: 'entry' | 'commented-entry'
      rawLine: string
      lineNumber: number
      key: string
      prefix: string
      rawValue: string
    }
  | { kind: 'invalid'; rawLine: string; lineNumber: number; reason: string }
type EnvLineData =
  | { kind: 'empty' | 'comment'; rawLine: string }
  | {
      kind: 'entry' | 'commented-entry'
      rawLine: string
      key: string
      prefix: string
      rawValue: string
    }
  | { kind: 'invalid'; rawLine: string; reason: string }

interface TextDocument {
  hasBom: boolean
  eol: string
  hasFinalNewline: boolean
  lines: string[]
}

interface EnvBlock {
  key: string
  kind: 'entry' | 'commented-entry'
  rawLine: string
  rawValue: string
  leadingLines: string[]
  lineNumber: number
  order: number
}

interface EnvGroup {
  key: string
  order: number
  blocks: EnvBlock[]
  leadingLines: string[]
  rawLines: string[]
}

export type SortOperationAction =
  | 'move'
  | 'insert-commented'
  | 'append-extra'
  | 'append-duplicate'
  | 'group-duplicate'

export interface EnvSortPlan {
  filePath: string
  templateFilePath: string
  changed: boolean
  currentContent: string
  nextContent: string
  operations: Array<{ action: SortOperationAction; key: string }>
  summary: {
    movedCount: number
    insertedCommentedCount: number
    appendedExtraCount: number
    appendedDuplicateCount: number
    groupedDuplicateCount: number
  }
}

const ENV_ENTRY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const COMMENTED_ENV_ENTRY_RE = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

function portable(file: string): string {
  return file.replace(/\\/g, '/').replaceAll(path.sep, '/')
}

function readSortConfig(configPath: string): EnvSortConfig {
  const abs = path.resolve(configPath)
  if (!existsSync(abs)) throw new Error(`Sort config does not exist: ${abs}`)
  const baseDir = path.dirname(abs)
  const raw = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as {
    envFiles?: unknown
    sort?: unknown
  }
  const envFiles = Array.isArray(raw.envFiles)
    ? [
        ...new Set(
          raw.envFiles.map((file) => {
            if (typeof file !== 'string' || !file.trim()) {
              throw new Error('Each entry in config.envFiles must be a non-empty string.')
            }
            return path.resolve(baseDir, file)
          }),
        ),
      ]
    : []

  if (
    raw.sort !== undefined &&
    (!raw.sort || typeof raw.sort !== 'object' || Array.isArray(raw.sort))
  ) {
    throw new Error('config.sort must be an object keyed by sort target.')
  }

  return {
    baseDir,
    envFiles,
    sort: raw.sort as EnvSortConfig['sort'],
  }
}

function emitCommandChange(
  command: 'sort',
  payload: Record<string, string | number | boolean | undefined>,
): void {
  console.log(`[env-store-change] ${JSON.stringify({ command, ...payload })}`)
}

function createEmptyDocument(): TextDocument {
  return { hasBom: false, eol: '\n', hasFinalNewline: true, lines: [] }
}

function createTextDocument(content: string): TextDocument {
  const hasBom = content.startsWith('\uFEFF')
  const raw = hasBom ? content.slice(1) : content
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = raw.length > 0 && /\r?\n$/.test(raw)
  let lines = raw.length > 0 ? raw.split(/\r\n|\n/) : []
  if (hasFinalNewline && lines.at(-1) === '') lines = lines.slice(0, -1)
  return { hasBom, eol, hasFinalNewline, lines }
}

function renderTextDocument(document: TextDocument, lines: string[]): string {
  const body = lines.join(document.eol)
  const withNewline = lines.length > 0 && document.hasFinalNewline ? `${body}${document.eol}` : body
  return document.hasBom ? `\uFEFF${withNewline}` : withNewline
}

function parseEnvLine(line: string): EnvLineData {
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

function loadEnvDocument(filePath: string) {
  const fileExists = existsSync(filePath)
  const document = fileExists
    ? createTextDocument(readFileSync(filePath, 'utf8'))
    : createEmptyDocument()
  const parsedLines: EnvLine[] = document.lines.map((line, index) => ({
    lineNumber: index + 1,
    ...parseEnvLine(line),
  }))
  return { exists: fileExists, document, parsedLines }
}

function isEnvEntryLikeLine(
  line: EnvLine,
): line is EnvLine & { kind: 'entry' | 'commented-entry'; key: string; rawValue: string } {
  return line.kind === 'entry' || line.kind === 'commented-entry'
}

function buildEnvSortLayout(envDoc: ReturnType<typeof loadEnvDocument>) {
  const blocks: EnvBlock[] = []
  let preambleLines: string[] = []
  let pendingLines: string[] = []
  let sawEntry = false

  for (const line of envDoc.parsedLines) {
    if (isEnvEntryLikeLine(line)) {
      if (!sawEntry) {
        preambleLines = pendingLines
        pendingLines = []
        sawEntry = true
      }
      blocks.push({
        key: line.key,
        kind: line.kind,
        rawLine: line.rawLine,
        rawValue: line.rawValue,
        leadingLines: pendingLines,
        lineNumber: line.lineNumber,
        order: blocks.length,
      })
      pendingLines = []
      continue
    }
    pendingLines.push(line.rawLine)
  }

  if (!sawEntry) {
    preambleLines = pendingLines
    pendingLines = []
  }
  return { preambleLines, blocks, suffixLines: pendingLines }
}

function hasCommentedEnvValue(block: EnvBlock): boolean {
  const trimmed = block.rawValue.trim()
  return trimmed !== '' && !trimmed.startsWith('#')
}

function shouldIgnoreEmptyCommentedEnvBlock(block: EnvBlock, groupBlocks: EnvBlock[]): boolean {
  if (block.kind !== 'commented-entry' || hasCommentedEnvValue(block)) return false
  return groupBlocks.some(
    (candidate) =>
      candidate !== block && (candidate.kind === 'entry' || hasCommentedEnvValue(candidate)),
  )
}

function isBlankLine(line: string): boolean {
  return line.trim() === ''
}

function normalizeBlankLineRuns(lines: string[]): string[] {
  const normalizedLines: string[] = []
  for (const line of lines) {
    if (
      isBlankLine(line) &&
      normalizedLines.length > 0 &&
      isBlankLine(normalizedLines.at(-1) ?? '')
    )
      continue
    normalizedLines.push(line)
  }
  return normalizedLines
}

function buildEnvSortGroups(blocks: EnvBlock[]): EnvGroup[] {
  const groupedBlocks = new Map<string, EnvBlock[]>()
  for (const block of blocks) {
    const groupBlocks = groupedBlocks.get(block.key) ?? []
    groupBlocks.push(block)
    groupedBlocks.set(block.key, groupBlocks)
  }

  const groups: EnvGroup[] = []
  for (const [key, groupBlocks] of groupedBlocks) {
    const keptBlocks = groupBlocks.filter(
      (block) => !shouldIgnoreEmptyCommentedEnvBlock(block, groupBlocks),
    )
    if (keptBlocks.length === 0) continue
    groups.push({
      key,
      order: Math.min(...keptBlocks.map((block) => block.order)),
      blocks: keptBlocks,
      leadingLines: normalizeBlankLineRuns(groupBlocks.flatMap((block) => block.leadingLines)),
      rawLines: keptBlocks.map((block) => block.rawLine),
    })
  }
  groups.sort((left, right) => left.order - right.order)
  return groups
}

function buildCommentLineSet(lines: string[]): Set<string> {
  const normalizedComments = new Set<string>()
  for (const line of lines) {
    const parsed = parseEnvLine(line)
    if (parsed.kind === 'comment') normalizedComments.add(line.trim())
  }
  return normalizedComments
}

function partitionPreambleLines(templateLines: string[], envLines: string[]) {
  const normalizedTemplateLines = normalizeBlankLineRuns(templateLines)
  const normalizedEnvLines = normalizeBlankLineRuns(envLines)
  if (normalizedEnvLines.length === 0) return { matchedTemplateLines: [], extraLines: [] }
  if (normalizedTemplateLines.length === 0) {
    return {
      matchedTemplateLines: [],
      extraLines: normalizedEnvLines.filter((line) => !isBlankLine(line)),
    }
  }
  const templateComments = buildCommentLineSet(normalizedTemplateLines)
  const matchedTemplateLines: string[] = []
  const extraLines: string[] = []
  for (const line of normalizedEnvLines) {
    const parsed = parseEnvLine(line)
    if (parsed.kind === 'comment' && templateComments.has(line.trim())) {
      matchedTemplateLines.push(line)
      continue
    }
    if (parsed.kind === 'empty') continue
    extraLines.push(line)
  }
  return {
    matchedTemplateLines: normalizeBlankLineRuns(matchedTemplateLines),
    extraLines: normalizeBlankLineRuns(extraLines),
  }
}

function mergeLeadingLines(templateLines: string[], envLines: string[]): string[] {
  const normalizedTemplateLines = normalizeBlankLineRuns(templateLines)
  if (normalizedTemplateLines.length === 0) return normalizeBlankLineRuns(envLines)
  const templateComments = buildCommentLineSet(normalizedTemplateLines)
  const unmatchedEnvLines = normalizeBlankLineRuns(
    envLines.filter((line) => {
      const parsed = parseEnvLine(line)
      if (parsed.kind === 'empty') return false
      return parsed.kind !== 'comment' || !templateComments.has(line.trim())
    }),
  )
  if (unmatchedEnvLines.length === 0) return normalizedTemplateLines
  const mergedLines = [...normalizedTemplateLines]
  if (!isBlankLine(mergedLines.at(-1) ?? '') && !isBlankLine(unmatchedEnvLines[0]))
    mergedLines.push('')
  mergedLines.push(...unmatchedEnvLines)
  return normalizeBlankLineRuns(mergedLines)
}

function commentOutEnvEntryLine(line: string): string {
  const parsed = parseEnvLine(line)
  if (parsed.kind === 'commented-entry') return parsed.rawLine
  if (parsed.kind !== 'entry') return `# ${line.trimStart()}`
  const indent = line.match(/^\s*/)?.[0] ?? ''
  return `${indent}# ${line.slice(indent.length)}`
}

export function buildEnvSortPlan(envFilePath: string, templateFilePath: string): EnvSortPlan {
  const resolvedEnvFilePath = path.resolve(envFilePath)
  const resolvedTemplateFilePath = path.resolve(templateFilePath)
  if (!existsSync(resolvedTemplateFilePath)) {
    throw new Error(`Template env file does not exist: ${resolvedTemplateFilePath}`)
  }

  const envDoc = loadEnvDocument(resolvedEnvFilePath)
  const templateDoc = loadEnvDocument(resolvedTemplateFilePath)
  const envLayout = buildEnvSortLayout(envDoc)
  const templateLayout = buildEnvSortLayout(templateDoc)

  if (envLayout.blocks.length > 0) {
    const { matchedTemplateLines, extraLines } = partitionPreambleLines(
      templateLayout.preambleLines,
      envLayout.preambleLines,
    )
    envLayout.preambleLines = matchedTemplateLines
    if (extraLines.length > 0) {
      envLayout.blocks[0] = {
        ...envLayout.blocks[0],
        leadingLines: normalizeBlankLineRuns([...extraLines, ...envLayout.blocks[0].leadingLines]),
      }
    }
  }

  const envGroups = new Map(buildEnvSortGroups(envLayout.blocks).map((group) => [group.key, group]))
  const templateKeys = new Set(templateLayout.blocks.map((block) => block.key))
  const templateBlocksByKey: EnvBlock[] = []
  const seenTemplateKeys = new Set<string>()
  for (const block of templateLayout.blocks) {
    if (seenTemplateKeys.has(block.key)) continue
    seenTemplateKeys.add(block.key)
    templateBlocksByKey.push(block)
  }

  const renderedLines = mergeLeadingLines(templateLayout.preambleLines, envLayout.preambleLines)
  const consumedKeys = new Set<string>()
  const operations: EnvSortPlan['operations'] = []
  let renderedOrder = 0
  for (const templateBlock of templateBlocksByKey) {
    const envGroup = envGroups.get(templateBlock.key)
    if (envGroup) {
      consumedKeys.add(envGroup.key)
      renderedLines.push(
        ...mergeLeadingLines(templateBlock.leadingLines, envGroup.leadingLines),
        ...envGroup.rawLines,
      )
      if (envGroup.order !== renderedOrder) operations.push({ action: 'move', key: envGroup.key })
      if (envGroup.blocks.length > 1)
        operations.push({ action: 'group-duplicate', key: envGroup.key })
      renderedOrder++
      continue
    }
    renderedLines.push(...templateBlock.leadingLines, commentOutEnvEntryLine(templateBlock.rawLine))
    operations.push({ action: 'insert-commented', key: templateBlock.key })
    renderedOrder++
  }

  const leftoverGroups = [...envGroups.values()].filter((group) => !consumedKeys.has(group.key))
  for (const group of leftoverGroups) {
    renderedLines.push(...group.leadingLines, ...group.rawLines)
    operations.push({
      action: templateKeys.has(group.key) ? 'append-duplicate' : 'append-extra',
      key: group.key,
    })
    renderedOrder++
  }
  renderedLines.push(...mergeLeadingLines(templateLayout.suffixLines, envLayout.suffixLines))

  const renderDocument = envDoc.exists ? envDoc.document : templateDoc.document
  const currentContent = envDoc.exists
    ? renderTextDocument(envDoc.document, envDoc.document.lines)
    : ''
  const nextContent = renderTextDocument(renderDocument, renderedLines)
  const summary = operations.reduce(
    (acc, operation) => {
      if (operation.action === 'move') acc.movedCount++
      else if (operation.action === 'insert-commented') acc.insertedCommentedCount++
      else if (operation.action === 'append-extra') acc.appendedExtraCount++
      else if (operation.action === 'append-duplicate') acc.appendedDuplicateCount++
      else if (operation.action === 'group-duplicate') acc.groupedDuplicateCount++
      return acc
    },
    {
      movedCount: 0,
      insertedCommentedCount: 0,
      appendedExtraCount: 0,
      appendedDuplicateCount: 0,
      groupedDuplicateCount: 0,
    },
  )

  return {
    filePath: resolvedEnvFilePath,
    templateFilePath: resolvedTemplateFilePath,
    changed: currentContent !== nextContent,
    currentContent,
    nextContent,
    operations,
    summary,
  }
}

export async function sortEnvFile(envFilePath: string, templateFilePath: string) {
  const plan = buildEnvSortPlan(envFilePath, templateFilePath)
  if (!plan.changed) {
    return {
      applied: false,
      filePath: plan.filePath,
      templateFilePath: plan.templateFilePath,
      ...plan.summary,
    }
  }
  mkdirSync(path.dirname(plan.filePath), { recursive: true })
  writeFileSync(plan.filePath, plan.nextContent, 'utf8')
  for (const operation of plan.operations) {
    emitCommandChange('sort', {
      action: operation.action,
      filePath: portable(plan.filePath),
      templateFilePath: portable(plan.templateFilePath),
      key: operation.key,
    })
  }
  emitCommandChange('sort', {
    action: 'write-file',
    filePath: portable(plan.filePath),
    templateFilePath: portable(plan.templateFilePath),
  })
  return {
    applied: true,
    filePath: plan.filePath,
    templateFilePath: plan.templateFilePath,
    ...plan.summary,
  }
}

function normalizeSortSelector(
  value: string | undefined,
  fallback: string,
  fieldName: string,
): string {
  const normalized =
    value === undefined || value === null || value === '' ? fallback : String(value).trim()
  if (!normalized) return fallback
  if (fieldName === 'env-suffix' && normalized === 'default') return ''
  return normalized
}

function interpolateSortFilePattern(pattern: string, envSuffix: string): string {
  return pattern.replaceAll('{env}', envSuffix).replaceAll('{suffix}', envSuffix)
}

function getEnvSuffixFromDefaultFile(
  defaultFilePath: string,
  candidateFilePath: string,
): string | null {
  if (candidateFilePath === defaultFilePath) return ''
  const prefix = `${defaultFilePath}.`
  if (!candidateFilePath.startsWith(prefix)) return null
  const suffix = candidateFilePath.slice(prefix.length)
  return suffix && suffix !== 'example' ? suffix : null
}

export async function sortEnvFilesFromConfig(
  configPath: string,
  keyArg = 'all',
  envSuffixArg = 'all',
) {
  const config = readSortConfig(configPath)
  if (!config.sort) throw new Error('config.sort is required for sortEnvFilesFromConfig.')
  const keySelector = normalizeSortSelector(keyArg, 'all', 'key')
  const envSuffixSelector = normalizeSortSelector(envSuffixArg, 'all', 'env-suffix')
  const selectedTargets = Object.entries(config.sort).filter(
    ([key]) => keySelector === 'all' || key === keySelector,
  )
  if (selectedTargets.length === 0) throw new Error(`Unknown sort key: ${keySelector}`)

  const results = []
  for (const [key, target] of selectedTargets) {
    const defaultFilePath = path.resolve(config.baseDir, target.file)
    const templateFilePath = path.resolve(config.baseDir, target.template)
    const files = new Map<string, string>([['', defaultFilePath]])
    for (const envFilePath of config.envFiles) {
      const suffix = getEnvSuffixFromDefaultFile(defaultFilePath, envFilePath)
      if (suffix !== null) files.set(suffix, envFilePath)
    }
    if (target.files) {
      for (const [suffix, file] of Object.entries(target.files)) {
        if (suffix === 'default')
          throw new Error(`config.sort.${key}.files must not use reserved suffix "default".`)
        files.set(suffix, path.resolve(config.baseDir, interpolateSortFilePattern(file, suffix)))
      }
    }

    const jobs =
      envSuffixSelector === 'all'
        ? [...files.entries()]
        : [
            [
              envSuffixSelector,
              files.get(envSuffixSelector) ??
                path.resolve(
                  path.dirname(defaultFilePath),
                  `${path.basename(defaultFilePath)}.${envSuffixSelector}`,
                ),
            ],
          ]
    for (const [, file] of jobs) results.push(await sortEnvFile(file, templateFilePath))
  }
  return { applied: results.some((result) => result.applied), count: results.length, results }
}
