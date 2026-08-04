export type VaultOperation = 'set' | 'delete'
export type RestoreAction = 'add' | 'modify' | 'delete' | 'identical' | 'conflict'
export type VaultConflictStrategy = 'abort' | 'keep-local' | 'take-vault'
export type VaultRestoreRedaction = 'full' | 'partial' | 'none'
export type RestoreDecisionChoice = 'apply-vault' | 'keep-local' | 'skip'

export interface VaultRestoreReveal {
  start: number
  end: number
}

export interface RestoreDecision {
  entryId: string
  decision: RestoreDecisionChoice
}

export interface VaultRecord {
  version: 0 | 1
  f: string
  k: string
  t: number
  op: VaultOperation
  v?: string
  order?: number
}

export interface RestorePlanEntry {
  entryId: string
  filePath: string
  key: string
  action: RestoreAction
  occurrenceCount: number
  conflict?: boolean
  vaultAction?: Exclude<RestoreAction, 'conflict'>
  conflictReason?: string
  preview: {
    current: string
    vault: string
  }
}

export interface RestorePlanFile {
  filePath: string
  entries: RestorePlanEntry[]
  changed: boolean
}

export interface RestorePlan {
  version: 1
  createdAt: number
  planDigest: string
  storeDigest: string
  storePath: string
  files: RestorePlanFile[]
  summary: Record<RestoreAction, number> & { filesWithChanges: number }
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
  unmanagedStoreFiles: string[]
}
