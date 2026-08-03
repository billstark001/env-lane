import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError, writeFileContentAtomically } from '@env-lane/core'
import { z } from 'zod'
import { buildDefaultRestoreDecisions, type VaultSelectionOptions } from './selection.js'
import type { RestoreDecision, RestorePlan } from './store.js'

const restoreActionSchema = z.enum(['add', 'modify', 'delete', 'identical', 'conflict'])
const restorePlanEntrySchema = z.object({
  entryId: z.string().length(64),
  filePath: z.string().min(1),
  key: z.string().min(1),
  action: restoreActionSchema,
  occurrenceCount: z.number().int().nonnegative(),
  conflict: z.boolean().optional(),
  vaultAction: z.enum(['add', 'modify', 'delete', 'identical']).optional(),
  conflictReason: z.string().optional(),
  preview: z.object({ current: z.string(), vault: z.string() }),
})
const restorePlanSchema = z.object({
  version: z.literal(1),
  createdAt: z.number().nonnegative(),
  planDigest: z.string().length(64),
  storeDigest: z.string().length(64),
  storePath: z.string().min(1),
  files: z.array(
    z.object({
      filePath: z.string().min(1),
      entries: z.array(restorePlanEntrySchema),
      changed: z.boolean(),
    }),
  ),
  summary: z.object({
    add: z.number().int().nonnegative(),
    modify: z.number().int().nonnegative(),
    delete: z.number().int().nonnegative(),
    identical: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    filesWithChanges: z.number().int().nonnegative(),
  }),
  failedRecords: z.number().int().nonnegative(),
  parsedRecords: z.number().int().nonnegative(),
  rawRecords: z.number().int().nonnegative(),
  aliasedRecords: z.number().int().nonnegative(),
  unmanagedStoreFiles: z.array(z.string()),
})
const decisionSchema = z.object({
  entryId: z.string().length(64),
  decision: z.enum(['apply-vault', 'keep-local', 'skip']),
})
const approvalDocumentSchema = z.object({
  plan: restorePlanSchema,
  decisions: z.array(decisionSchema),
})

export interface ApprovalDocument {
  plan: RestorePlan
  decisions: RestoreDecision[]
}

export function createApprovalDocument(
  plan: RestorePlan,
  options: VaultSelectionOptions,
): ApprovalDocument {
  return { plan, decisions: buildDefaultRestoreDecisions(plan, options) }
}

export function readApprovalDocument(filePath: string): ApprovalDocument {
  try {
    const document = approvalDocumentSchema.parse(
      JSON.parse(readFileSync(path.resolve(filePath), 'utf8')),
    ) as ApprovalDocument
    const expectedIds = new Set(
      document.plan.files.flatMap((file) =>
        file.entries.filter((entry) => entry.action !== 'identical').map((entry) => entry.entryId),
      ),
    )
    const decisionIds = new Set(document.decisions.map((decision) => decision.entryId))
    if (
      decisionIds.size !== document.decisions.length ||
      decisionIds.size !== expectedIds.size ||
      [...decisionIds].some((entryId) => !expectedIds.has(entryId))
    ) {
      throw new Error('Decisions must cover every non-identical plan entry exactly once.')
    }
    return document
  } catch (error) {
    throw new EnvLaneError('VAULT_INVALID_PLAN_FILE', 'Invalid Vault approval document.', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

export function writeApprovalDocument(filePath: string, document: ApprovalDocument): void {
  writeFileContentAtomically(path.resolve(filePath), `${JSON.stringify(document, null, 2)}\n`)
}
