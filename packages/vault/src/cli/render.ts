import path from 'node:path'
import { callNativeVault } from '../adapters/native.js'
import type { RestorePlan } from '../domain/types.js'
import type { VaultCliContext } from './types.js'

export function variableGroups(keys: string[]): Array<{ prefix: string | null; keys: string[] }> {
  return callNativeVault<{ value: Array<{ prefix: string | null; keys: string[] }> }>(
    'core.groupVariableKeys',
    { keys },
  ).value
}

export function inline(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

export function renderRestorePlan(ctx: VaultCliContext, plan: RestorePlan, root: string): void {
  ctx.output(`Restore plan for ${inline(path.relative(root, plan.storePath))}:`)
  for (const file of plan.files) {
    const changes = file.entries.filter((entry) => entry.action !== 'identical')
    if (changes.length === 0) continue
    ctx.output(`# ${inline(path.relative(root, file.filePath))}`)
    for (const group of variableGroups(changes.map((entry) => entry.key))) {
      if (group.prefix) ctx.output(`  ${inline(group.prefix)} (${group.keys.length})`)
      for (const key of group.keys) {
        for (const entry of changes.filter((entry) => entry.key === key)) {
          ctx.output(
            `    ${inline(entry.key)} [${entry.action}]: ${inline(entry.preview.current)} → ${inline(entry.preview.vault)}`,
          )
        }
      }
    }
  }
  ctx.output(
    `Summary: ${plan.summary.filesWithChanges} files to change, ${plan.summary.conflict} conflicts.`,
  )
}

export function renderVariableChanges(
  ctx: VaultCliContext,
  changes: Array<{ filePath: string; key: string; action: string }>,
  root: string,
): void {
  const files = new Map<string, Array<{ key: string; action: string }>>()
  for (const change of changes) {
    const entries = files.get(change.filePath) ?? []
    entries.push(change)
    files.set(change.filePath, entries)
  }
  for (const [file, entries] of files) {
    ctx.output(`\n${inline(path.relative(root, file).split(path.sep).join('/'))}`)
    for (const group of variableGroups(entries.map((entry) => entry.key))) {
      if (group.prefix) ctx.output(`  ${inline(group.prefix)} (${group.keys.length})`)
      for (const key of group.keys) {
        const actions = [
          ...new Set(entries.filter((entry) => entry.key === key).map((entry) => entry.action)),
        ]
        ctx.output(`    ${inline(key)} [${actions.join(', ')}]`)
      }
    }
  }
}
