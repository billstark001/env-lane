# Architecture

Env-lane uses coarse-grained layers to make dependency direction visible without turning every
function into a separate file. The 0.4.0 restructuring intentionally kept roughly the previous
implementation and test file count.

## Package ownership

| Package | Owns |
| --- | --- |
| `@env-lane/core` | Configuration, workspace discovery, dotenv model/resolution, policies, redaction, sorting, diagnostics. |
| `@env-lane/vault` | Development Vault configuration, records, sync baseline, restore planning/apply, history, optional Vault CLI adapter. |
| `env-lane` | Executable composition, Core command presentation, output streams, optional Vault loading, stable Core convenience facade. |

Core must not depend on Vault or the CLI package. Vault may depend on Core. The CLI may depend on
Core and dynamically load the optional Vault CLI entry.

## Coarse-grained layers

### Core

~~~text
packages/core/src/
  domain/       types, errors, variants, redaction
  application/  dotenv resolution, checks, policies, run, sort, workspace, env document
  adapters/     config loading, file writes, diagnostic context
  index.ts      curated public root
  env-document.ts  stable feature facade
~~~

### Vault

~~~text
packages/vault/src/
  domain/       persisted and restore-plan types
  application/  push, restore, storage/history, sync state
  adapters/     config, crypto, file locking
  cli/          Commander registration, prompts, rendering, warnings
  index.ts      curated automation root
~~~

### CLI

~~~text
packages/cli/src/
  presentation/
    commands/   Core and sort command registration
    runtime/    option merge, output, errors, bootstrap context
  cli.ts        executable composition and optional Vault loading
  index.ts      stable Core convenience facade
~~~

The layers describe dependency responsibility rather than promising one file per concept. Split a
file only when it has multiple independently changing responsibilities, a harmful dependency
cycle, or a test boundary that cannot otherwise be expressed.

Tests mirror these coarse areas under `test/application`, `test/domain`, and
`test/presentation` or `test/cli`. A suite may still cover several closely related functions;
the directory communicates the primary boundary.

## Public boundaries

Package roots explicitly curate exports. Internal source paths are not public entry points.
`@env-lane/core/env-document` and `@env-lane/vault/cli` are stable feature entries whose facade
files isolate consumers from implementation moves.

Compatibility re-exports are marked deprecated in declarations and remain only for the migration
window described in [API and compatibility](api.md). Do not add another root re-export solely to
avoid updating an internal import.

## Dotenv model invariant

Runtime resolution and editing share one line-level env document model. It must:

- preserve concrete syntax where possible, including BOM, EOL, comments, separators, and suffixes;
- expose a `dotenv`-compatible effective value;
- handle empty, quoted, multiline, duplicate, and commented entries consistently;
- keep checks, sync, sort, Vault restore, and runtime injection semantically aligned.

Parser or writer changes require both focused document tests and at least one consuming workflow
test. Do not reintroduce separate runtime/editor parsers.

## Output and diagnostics invariant

Library APIs are silent unless a caller supplies an async diagnostic context. Only presentation
layers may own stdout, stderr, exit status, and prompts.

- stdout contains only the final payload;
- diagnostics, warnings, progress, and prompts use stderr;
- JSON stdout is exactly one document;
- expected public errors have stable codes and preserve structured details;
- environment values are redacted by default;
- new JSON fields require a secret-leak review;
- `run` leaves stdout ownership to the child.

## Vault safety invariant

Vault apply is fail closed. Before writing, it binds:

1. the submitted plan body and digest;
2. the freshly recomputed store and local dotenv state;
3. the complete canonical entry set;
4. exactly one decision for every non-identical entry.

Deletes default to skipped. Only applied or identical entries advance the sync baseline.
`--fail-on` uses the selected plan and final decisions, never editable approval summaries.

Plans and diagnostics must not contain plaintext dotenv values.

## Vault persistence and concurrency

An operation lock serializes workflows for the same store. Lower-level file locks and atomic
replacement protect individual files; history rewrites also verify expected digests. Lock order is:

~~~text
operation lock -> store/sync-state file lock
~~~

Lower layers must never acquire the operation lock after taking a file lock.

Atomic rename is not a multi-file database transaction. Store, sync-state, and dotenv files are
individually crash-safe, but a process or machine failure between files may require a fresh plan and
baseline reconciliation. This limitation must remain documented unless persistence becomes a true
transactional store.

Persisted Vault record and sync-state compatibility is separate from API compatibility. Removing a
reader for an old schema requires an explicit migration tool or procedure; it must not be folded
silently into a later breaking export cleanup.

## Testing boundaries

Tests should cover three levels where relevant:

- pure/domain behavior;
- application and adapter integration;
- built published entries and real CLI child processes.

Tests must call production registration and wiring rather than reproduce it. Every public package
entry is checked in ESM, CommonJS, and declaration output. Security-sensitive redaction, approval,
selection, error, and concurrency changes require direct regression cases.
