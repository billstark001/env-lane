import type { RestorePlan } from '../types.js'
import type { VaultCliContext } from './types.js'

export function renderRestorePlan(ctx: VaultCliContext, plan: RestorePlan): void {
  ctx.output(`Restore plan for ${plan.storePath}:`)
  for (const file of plan.files) {
    const changes = file.entries.filter((entry) => entry.action !== 'identical')
    if (changes.length === 0) continue
    ctx.output(`# ${file.filePath}`)
    for (const entry of changes) {
      ctx.output(
        `  ${entry.action.padEnd(10)} ${entry.key}: ${entry.preview.current} -> ${entry.preview.vault}`,
      )
    }
  }
  ctx.output(
    `Summary: ${plan.summary.filesWithChanges} files to change, ${plan.summary.conflict} conflicts.`,
  )
}
