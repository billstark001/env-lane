# Development Vault

`@env-lane/vault` provides reversible encrypted dotenv record storage for development workflows.
It is intentionally not a production secret manager.

Encryption does not make a store or key file safe to publish. Env-lane cannot prevent Git,
cloud-sync clients, backups, shell histories, logs, or unrelated tools from copying local files.
Use CI/CD Secrets, cloud KMS, SOPS, age, HashiCorp Vault, or a platform Secret Manager for
production secrets.

## Install and configure

~~~bash
pnpm add -D env-lane @env-lane/vault
~~~

The default file is `env-lane.vault`; TypeScript, JavaScript ESM/CJS, and JSON are supported.

~~~ts
import { defineVaultConfig } from '@env-lane/vault';

export default defineVaultConfig({
  envFiles: [
    'apps/api/.env.local',
    'apps/web/.env.local'
  ],
  outputDir: '.env-lane-vault',
  outputFile: 'store.dat',
  trackDeletions: true,
  autoRemapPaths: true,
  allowUnmanaged: false,
  exclude: [
    {
      files: ['apps/api/.env.local'],
      keys: ['ETH_PRIVATE_KEY', 'WALLET_MNEMONIC']
    }
  ]
});
~~~

Paths declared inside the Vault config are resolved relative to that config file. The main env-lane
config may point to a different file through `vault.configFile`. An explicit relative
`--vault-config <file>` takes precedence and is resolved from `--cwd`.

Vault CLI commands emit the unsafe-development warning unless `disableUnsafeWarning` is enabled
in the main or Vault config. Library operations are silent. Programmatic callers that want the
same warning can call `warnUnsafeVault()` explicitly.

## Store format

Schema v1 records store dotenv effective values and a config-relative file path using `/` as the
portable separator. A store created in a macOS checkout therefore resolves against the Vault
config directory when read from a Windows checkout, without leaking or remapping the original
developer's absolute path. `autoRemapPaths` applies only to legacy absolute paths.

Versionless and version 0 records use the earlier raw right-hand-side representation and absolute
paths; they are converted through the shared env document model and may be remapped when read. New
records always use version 1.

The record format is append-oriented so prior values may remain in history. Pruning or sanitizing a
local store cannot recall copies already held elsewhere; rotate secrets after unwanted disclosure.

## Encrypt and plan

~~~bash
env-lane vault encrypt key.aes
env-lane vault encrypt key.aes --dry-run --json
env-lane vault plan key.aes --json
~~~

`encrypt` treats local dotenv files as its source. `plan` compares the current store with local
files and returns only redacted previews. Stable keyed entry identifiers and a plan digest bind the
plan to the current store and local state.

`encrypt --dry-run` performs selection, conflict detection, and change calculation but does not
take a write lock or create/update the store, sync state, or output directories. Its result reports
the records that a real encrypt would append. Conflict decisions remain explicit, exactly as for a
real encrypt.

Create an editable approval document:

~~~bash
env-lane vault plan key.aes --output restore-plan.json --json
~~~

The document contains the plan plus a decision for every non-identical entry. An apply operation
reloads the store and dotenv files, recomputes the plan, checks the digest and complete entry set,
and fails closed when either state or decisions are incomplete.

~~~bash
env-lane vault apply key.aes \
  --plan restore-plan.json \
  --yes \
  --non-interactive
~~~

Do not treat editable `summary` fields as an approval boundary; env-lane calculates CI failure
conditions from the fresh selected plan and final decisions.

## Selection and deletion

Encrypt, plan, and decrypt support:

- `--file <glob>`: match a file path.
- `--key <glob>`: match an env key.
- `--include <glob>`: match a `file:key` pair.
- `--exclude <glob>`: exclude a `file:key` pair.
- `--only add,modify,delete,conflict`: select action kinds.
- `--approve-deletes`: permit default delete selection.

Deletes are skipped by default. An approval document can opt in per entry with an explicit
`apply-vault` decision.

`--fail-on conflict|change|warning` evaluates only the selected plan/final decisions and returns
status 2 when matched.

## Conflict detection and sync state

Without `--sync-dir`, schema v1 has no causal baseline: encrypt treats local values as its source
and decrypt treats Vault as its source. Env-lane never guesses a winner from timestamps or file
mtimes.

Pass `--sync-dir` to opt into a local three-way baseline:

~~~bash
env-lane vault encrypt key.aes --sync-dir .env-lane-sync
env-lane vault plan key.aes --sync-dir .env-lane-sync
env-lane vault decrypt key.aes \
  --sync-dir .env-lane-sync \
  --yes \
  --conflicts take-vault
~~~

A relative `--sync-dir` is resolved from `--cwd`, like other CLI path arguments.

`vault-sync-state.json` contains relative paths, env key names, timestamps, and keyed
HMAC-SHA256 fingerprints. It contains no plaintext values. Legacy unkeyed state is treated as
schema v0 and safely rebased into v1.

Conflict policy is `abort` (default), `keep-local`, or `take-vault`. Library callers provide
decisions or a `resolveConflict(entry)` callback; library code never prompts or accesses terminal
streams.

## Local-only exclude rules

An exclude rule means matching values are never persisted, restored, synchronized, deleted, or
previewed by env-lane Vault. It does not stop other software from copying the source dotenv file.

If matching records already exist in history, normal operations fail closed. Inspect and remove all
matching historical lines before continuing:

~~~bash
env-lane vault sanitize key.aes --excluded --dry-run
env-lane vault sanitize key.aes --excluded --yes
~~~

Rotate any previously stored secret after sanitization.

## History

~~~bash
env-lane vault prune key.aes --keep-recent 3 --dry-run
env-lane vault prune key.aes --older-than-days 30 --yes
env-lane vault prune key.aes \
  --file apps/api/.env.local \
  --key API_TOKEN \
  --keep-recent 2 \
  --yes
~~~

Pruning preserves the latest matching record by default. Use `--no-preserve-latest` only when
removing current restore state is intentional.

## Write and concurrency boundaries

Operations on the same Vault store are serialized with an operation lock. Store append/rewrite,
sync-state writes, and dotenv writes use same-directory temporary files followed by atomic
replacement. History rewrites also validate the expected store digest.

Dry-run encrypt is the exception: because it cannot write, it takes no operation lock and creates
no parent directory. Its preview is advisory; a later real encrypt re-reads the store and sync state
under the operation lock before applying changes.

Atomic replacement prevents partial individual files; it does not turn several files into one
crash-atomic database transaction. After process or machine failure, rerun `plan` before applying
more changes and investigate any reported baseline conflict. Do not bypass or manually reorder lock
files.

## Library example

~~~ts
import {
  applyRestorePlan,
  buildRestorePlan,
  encryptEnvFiles
} from '@env-lane/vault';

await encryptEnvFiles(undefined, 'key.aes', {
  vaultConfigFile: 'env-lane.vault.ts',
  dryRun: true
});

const plan = await buildRestorePlan(undefined, 'key.aes', {
  vaultConfigFile: 'env-lane.vault.ts'
});

await applyRestorePlan(undefined, 'key.aes', plan, {
  autoApprove: true,
  decisions: plan.files.flatMap(file =>
    file.entries
      .filter(entry => entry.action !== 'identical')
      .map(entry => ({
        entryId: entry.entryId,
        decision: entry.action === 'delete' ? 'skip' : 'apply-vault'
      }))
  )
});
~~~

See [API and compatibility](api.md) for stable entry points and planned removals.
