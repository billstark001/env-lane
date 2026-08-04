import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnvLaneConfig } from '../adapters/config.js'
import {
  type AbsolutePath,
  absoluteDirname,
  assertAbsolutePath,
  resolveFromDirectory,
  resolveInvocationCwd,
} from '../adapters/paths.js'
import { EnvLaneError } from '../domain/errors.js'
import type {
  EnvSortTargetConfig,
  ResolvedEnvLaneConfig,
  WorkspacePackage,
} from '../domain/types.js'
import { DEFAULT_ENV_FILE_VARIANT, normalizeEnvFileVariant } from '../domain/variants.js'
import {
  isEnvEntryLikeLine,
  loadEnvDocument,
  parseEnvLine,
  renderEnvTextDocument,
  writeEnvDocumentContent,
} from './env-document.js'
import { listWorkspacePackagesForConfig } from './workspace.js'

type ResolvedEnvSortTargetConfig = Omit<EnvSortTargetConfig, 'baseDir'> & {
  baseDir: AbsolutePath
}

interface EnvSortConfig {
  baseDir: AbsolutePath
  envFiles: string[]
  sort: Record<string, ResolvedEnvSortTargetConfig>
  dotenv: ResolvedEnvLaneConfig['dotenv']
  selector: ResolvedEnvLaneConfig['selector']
  packages: WorkspacePackage[]
}

interface EnvBlock {
  key: string
  kind: 'entry' | 'commented-entry'
  rawLine: string
  rawLines: string[]
  effectiveValue: string
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

interface SortRenderOptions {
  preserveBOM?: boolean
  eol?: 'auto' | 'lf' | 'crlf'
  unlistedVariablesComment?: string
}

interface SortFileOptions extends SortRenderOptions {
  cwd?: string
  create?: boolean
  check?: boolean
}

interface SortConfigOptions {
  cwd?: string
  create?: boolean
  check?: boolean
  preserveBOM?: boolean
  eol?: 'auto' | 'lf' | 'crlf'
}

async function loadSortConfig(
  configPath: AbsolutePath | undefined,
  configDiscoveryCwd: AbsolutePath,
): Promise<EnvSortConfig> {
  let config: ResolvedEnvLaneConfig
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new EnvLaneError('SORT_CONFIG_NOT_FOUND', `Sort config does not exist: ${configPath}`)
    }
    config = await loadEnvLaneConfig({
      cwd: configDiscoveryCwd,
      configFile: configPath,
    })
  } else {
    config = await loadEnvLaneConfig({ cwd: configDiscoveryCwd })
  }
  const packages = await listWorkspacePackagesForConfig(config)
  const sort: Record<string, EnvSortTargetConfig> = { ...config.sort }

  const handledAliases = new Set<string>()

  for (const pkg of packages) {
    for (const alias of pkg.aliases) {
      handledAliases.add(alias)
      const target = sort[alias] ?? {}
      sort[alias] = {
        ...target,
        baseDir: target.baseDir ?? pkg.dir,
        file: target.file ?? '.env',
        template: target.template ?? '.env.example',
        unlistedVariablesComment: target.unlistedVariablesComment ?? '',
      }
    }
  }

  for (const [key, target] of Object.entries(sort)) {
    if (handledAliases.has(key)) continue
    sort[key] = {
      ...target,
      baseDir: target.baseDir ?? config.rootDir,
      file: target.file ?? '.env',
      template: target.template ?? '.env.example',
      unlistedVariablesComment: target.unlistedVariablesComment ?? '',
    }
  }

  assertAbsolutePath(config.rootDir, 'Project root')
  const resolvedSort = Object.fromEntries(
    Object.entries(sort).map(([key, target]) => {
      const baseDir = target.baseDir ?? config.rootDir
      assertAbsolutePath(baseDir, `Sort target ${key} baseDir`)
      return [key, { ...target, baseDir }]
    }),
  )

  return {
    baseDir: config.rootDir,
    envFiles: [],
    sort: resolvedSort,
    dotenv: config.dotenv,
    selector: config.selector,
    packages,
  }
}

function buildEnvSortLayout(envDoc: ReturnType<typeof loadEnvDocument>) {
  const blocks: EnvBlock[] = []
  let preambleLines: string[] = []
  let pendingLines: string[] = []
  let sawEntry = false

  for (const line of envDoc.parsedLines) {
    if (line.kind === 'continuation') {
      blocks.at(-1)?.rawLines.push(line.rawLine)
      continue
    }
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
        rawLines: [line.rawLine],
        effectiveValue: line.effectiveValue,
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
  return block.effectiveValue !== ''
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
      rawLines: keptBlocks.flatMap((block) => block.rawLines),
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

function renderUnlistedVariablesComment(value: string): string[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()
  return lines.map((line) => {
    if (line.trim() === '') return ''
    return line.trimStart().startsWith('#') ? line : `# ${line}`
  })
}

function removeRenderedUnlistedVariablesComment(lines: string[], comment: string[]): string[] {
  if (comment.length === 0 || lines.length < comment.length) return lines
  const nextLines = [...lines]
  for (let index = nextLines.length - comment.length; index >= 0; index -= 1) {
    const matches = comment.every((line, offset) => nextLines[index + offset] === line)
    if (!matches) continue
    const removeFrom = index > 0 && isBlankLine(nextLines[index - 1]) ? index - 1 : index
    nextLines.splice(removeFrom, index + comment.length - removeFrom)
  }
  return normalizeBlankLineRuns(nextLines)
}

function summarizeSortOperations(operations: EnvSortPlan['operations']): EnvSortPlan['summary'] {
  return operations.reduce(
    (summary, operation) => {
      if (operation.action === 'move') summary.movedCount++
      else if (operation.action === 'insert-commented') summary.insertedCommentedCount++
      else if (operation.action === 'append-extra') summary.appendedExtraCount++
      else if (operation.action === 'append-duplicate') summary.appendedDuplicateCount++
      else if (operation.action === 'group-duplicate') summary.groupedDuplicateCount++
      return summary
    },
    {
      movedCount: 0,
      insertedCommentedCount: 0,
      appendedExtraCount: 0,
      appendedDuplicateCount: 0,
      groupedDuplicateCount: 0,
    },
  )
}

function buildEnvSortPlanResolved(
  envFilePath: AbsolutePath,
  templateFilePath: AbsolutePath,
  options?: SortRenderOptions,
): EnvSortPlan {
  if (!existsSync(templateFilePath)) {
    throw new EnvLaneError(
      'SORT_TEMPLATE_NOT_FOUND',
      `Template env file does not exist: ${templateFilePath}`,
    )
  }

  const envDoc = loadEnvDocument(envFilePath)
  const templateDoc = loadEnvDocument(templateFilePath)
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
    renderedLines.push(
      ...templateBlock.leadingLines,
      ...templateBlock.rawLines.map(commentOutEnvEntryLine),
    )
    operations.push({ action: 'insert-commented', key: templateBlock.key })
    renderedOrder++
  }

  const leftoverGroups = [...envGroups.values()].filter((group) => !consumedKeys.has(group.key))
  const unlistedVariablesComment = renderUnlistedVariablesComment(
    options?.unlistedVariablesComment ?? '',
  )
  let renderedUnlistedVariablesComment = false
  for (const group of leftoverGroups) {
    const leadingLines = !templateKeys.has(group.key)
      ? removeRenderedUnlistedVariablesComment(group.leadingLines, unlistedVariablesComment)
      : group.leadingLines
    if (
      !templateKeys.has(group.key) &&
      !renderedUnlistedVariablesComment &&
      unlistedVariablesComment.length > 0
    ) {
      if (!isBlankLine(renderedLines.at(-1) ?? '')) renderedLines.push('')
      renderedLines.push(...unlistedVariablesComment)
      renderedUnlistedVariablesComment = true
    }
    renderedLines.push(...leadingLines, ...group.rawLines)
    operations.push({
      action: templateKeys.has(group.key) ? 'append-duplicate' : 'append-extra',
      key: group.key,
    })
    renderedOrder++
  }
  renderedLines.push(...mergeLeadingLines(templateLayout.suffixLines, envLayout.suffixLines))

  const renderDocument = envDoc.exists ? envDoc.document : templateDoc.document
  const currentContent = envDoc.exists
    ? renderEnvTextDocument(envDoc.document, envDoc.document.lines)
    : ''
  const nextContent = renderEnvTextDocument(renderDocument, renderedLines, options)
  const summary = summarizeSortOperations(operations)

  return {
    filePath: envFilePath,
    templateFilePath,
    changed: currentContent !== nextContent,
    currentContent,
    nextContent,
    operations,
    summary,
  }
}

export function buildEnvSortPlan(
  envFilePath: string,
  templateFilePath: string,
  options?: SortRenderOptions & { cwd?: string },
): EnvSortPlan {
  const invocationCwd = resolveInvocationCwd(options?.cwd)
  return buildEnvSortPlanResolved(
    resolveFromDirectory(invocationCwd, envFilePath),
    resolveFromDirectory(invocationCwd, templateFilePath),
    {
      preserveBOM: options?.preserveBOM,
      eol: options?.eol,
      unlistedVariablesComment: options?.unlistedVariablesComment,
    },
  )
}

async function sortEnvFileResolved(
  envFilePath: AbsolutePath,
  templateFilePath: AbsolutePath,
  options?: Omit<SortFileOptions, 'cwd'>,
) {
  const create = options?.create ?? true

  if (!create && !existsSync(envFilePath)) {
    return {
      applied: false,
      changed: false,
      filePath: envFilePath,
      templateFilePath,
      operations: [],
      movedCount: 0,
      insertedCommentedCount: 0,
      appendedExtraCount: 0,
      appendedDuplicateCount: 0,
      groupedDuplicateCount: 0,
    }
  }

  const plan = buildEnvSortPlanResolved(envFilePath, templateFilePath, options)
  if (!plan.changed) {
    return {
      applied: false,
      changed: false,
      filePath: plan.filePath,
      templateFilePath: plan.templateFilePath,
      operations: plan.operations,
      ...plan.summary,
    }
  }
  if (options?.check) {
    return {
      applied: false,
      changed: true,
      filePath: plan.filePath,
      templateFilePath: plan.templateFilePath,
      operations: plan.operations,
      ...plan.summary,
    }
  }
  writeEnvDocumentContent(plan.filePath, plan.nextContent)
  return {
    applied: true,
    changed: true,
    filePath: plan.filePath,
    templateFilePath: plan.templateFilePath,
    operations: plan.operations,
    ...plan.summary,
  }
}

export async function sortEnvFile(
  envFilePath: string,
  templateFilePath: string,
  options?: SortFileOptions,
) {
  const invocationCwd = resolveInvocationCwd(options?.cwd)
  return sortEnvFileResolved(
    resolveFromDirectory(invocationCwd, envFilePath),
    resolveFromDirectory(invocationCwd, templateFilePath),
    {
      create: options?.create,
      check: options?.check,
      preserveBOM: options?.preserveBOM,
      eol: options?.eol,
      unlistedVariablesComment: options?.unlistedVariablesComment,
    },
  )
}

function normalizeSortSelector(
  value: string | undefined,
  fallback: string,
  fieldName: string,
): string {
  if (fieldName === 'env-suffix') {
    return normalizeEnvFileVariant(value, {
      allowAll: true,
      fallback,
      fieldName,
    })
  }
  const normalized =
    value === undefined || value === null || value === '' ? fallback : String(value).trim()
  if (!normalized) return fallback
  return normalized
}

function interpolateSortFilePattern(pattern: string, envSuffix: string): string {
  return pattern.replaceAll('{env}', envSuffix).replaceAll('{suffix}', envSuffix)
}

export async function sortEnvFilesFromConfig(
  configPath?: string,
  keyArg = 'all',
  envSuffixArg = 'all',
  options?: SortConfigOptions,
) {
  const invocationCwd = resolveInvocationCwd(options?.cwd)
  const resolvedConfigPath = configPath
    ? resolveFromDirectory(invocationCwd, configPath)
    : undefined
  const configDiscoveryCwd =
    options?.cwd === undefined && resolvedConfigPath
      ? absoluteDirname(resolvedConfigPath)
      : invocationCwd
  const config = await loadSortConfig(resolvedConfigPath, configDiscoveryCwd)
  const keySelector = normalizeSortSelector(keyArg, 'all', 'key')
  const envSuffixSelector = normalizeSortSelector(envSuffixArg, 'all', 'env-suffix')
  const selectedTargets = Object.entries(config.sort).filter(
    ([key]) => keySelector === 'all' || key === keySelector,
  )
  if (selectedTargets.length === 0) {
    throw new EnvLaneError('SORT_UNKNOWN_KEY', `Unknown sort key: ${keySelector}`)
  }

  const results = []
  const seenFiles = new Set<string>()
  for (const [key, target] of selectedTargets) {
    const baseDir = target.baseDir
    const file = target.file ?? '.env'
    const template = target.template ?? '.env.example'
    const defaultFilePath = resolveFromDirectory(baseDir, file)
    const templateFilePath = resolveFromDirectory(baseDir, template)
    const targetDir = absoluteDirname(defaultFilePath)
    const files = new Map<string, AbsolutePath>([[DEFAULT_ENV_FILE_VARIANT, defaultFilePath]])

    for (const pattern of config.dotenv.order) {
      if (pattern.includes('{build}')) {
        for (const build of config.selector.builds) {
          files.set(build, resolveFromDirectory(targetDir, pattern.replace('{build}', build)))
        }
      }
    }

    if (target.files) {
      for (const [suffix, file] of Object.entries(target.files)) {
        if (suffix === 'default')
          throw new EnvLaneError(
            'SORT_INVALID_CONFIG',
            `config.sort.${key}.files must not use reserved suffix "default".`,
          )
        files.set(suffix, resolveFromDirectory(baseDir, interpolateSortFilePattern(file, suffix)))
      }
    }

    const jobs: Array<[string, AbsolutePath]> =
      envSuffixSelector === 'all'
        ? [...files.entries()]
        : [
            [
              envSuffixSelector,
              files.get(envSuffixSelector) ??
                resolveFromDirectory(
                  targetDir,
                  `${path.basename(defaultFilePath)}.${envSuffixSelector}`,
                ),
            ],
          ]
    for (const [, file] of jobs) {
      if (seenFiles.has(file)) continue
      seenFiles.add(file)
      const mergedOptions = {
        create: options?.create ?? target.create,
        check: options?.check,
        preserveBOM: options?.preserveBOM ?? config.dotenv.preserveBOM,
        eol: options?.eol ?? config.dotenv.eol,
        unlistedVariablesComment: target.unlistedVariablesComment ?? '',
      }
      results.push(await sortEnvFileResolved(file, templateFilePath, mergedOptions))
    }
  }
  return {
    applied: results.some((result) => result.applied),
    changed: results.some((result) => result.changed),
    count: results.length,
    results,
  }
}
