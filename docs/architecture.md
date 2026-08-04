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
  adapters/     config/path loading, file writes, child execution, diagnostic context
  index.ts      curated public root
  env-document.ts  stable feature facade
~~~

### Vault

~~~text
packages/vault/src/
  domain/       persisted and restore-plan types
  application/  push, restore, storage/history, sync state
  adapters/     config/path loading, portable record paths, crypto, file locking
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

## Path resolution invariant

Path resolution distinguishes four concepts:

- `invocationCwd`: absolute directory used for config discovery and caller-supplied relative paths;
- `projectRoot`: absolute workspace root returned by the config adapter;
- `configDir`: directory that owns config-relative paths;
- `childCwd`: absolute directory passed to the child process adapter.

CLI presentation and every public library use case are input boundaries. They may accept an
optional raw `cwd`, normalize it once, and then pass an absolute `invocationCwd` onward. Private
application helpers must not read `process.cwd()` or reinterpret caller-relative paths. Once file
arguments are resolved, deeper sort, Vault, and process helpers receive absolute paths instead of
another optional cwd.

Internally, `AbsolutePath` is a nominal string type created only by the path adapter's resolution
helpers or by an assertion at an external-library boundary. This carries the proof through private
APIs, so they neither re-resolve nor repeatedly assert the same path. Do not cache path assertions:
`path.isAbsolute` is inexpensive, a string-value cache has lifecycle and memory costs, and it cannot
prove that the filesystem target still exists. The brand is a lexical proof of normalization, not a
filesystem-validity guarantee.

The global `--cwd` and run-specific `--run-cwd` are intentionally distinct. `--cwd` selects the
invocation context; `--run-cwd` selects `target`, `root`, or a child path relative to that context.
The child process adapter receives only the final absolute `childCwd`.

The run presentation layer treats the first explicit separator after env-lane options as the child
boundary. Once child parsing begins, every argument is opaque, including later standalone `--`
tokens.

Config adapters resolve config-owned paths. In particular, explicit sort `baseDir` values become
absolute when the main config is loaded, while file and template names remain relative to that
resolved target base. Vault config contents remain relative to the Vault config file.

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
- eligible environment values are redacted by default, with the documented short-value floor;
  otherwise plaintext Vault previews require an explicit `none` redaction mode;
- new JSON fields require a secret-leak review;
- `run` leaves stdout ownership to the child.

## Vault safety invariant

Vault apply is fail closed. Before writing, it binds:

1. the submitted plan body and digest;
2. the freshly recomputed store and local dotenv state;
3. the complete canonical entry set;
4. exactly one decision for every non-identical entry.

Deletes default to selected. An explicit opt-out leaves them skipped. Only applied or identical
entries advance the sync baseline. Encrypt treats missing managed files as empty by default and
records tombstones without creating or removing the local file.
`--fail-on` uses the selected plan and final decisions, never editable approval summaries.

Plans and diagnostics must not contain plaintext dotenv values.

## Vault persistence and concurrency

An operation lock serializes workflows for the same store. Lower-level file locks and atomic
replacement protect individual files; history rewrites also verify expected digests. Lock order is:

~~~text
operation lock -> store/sync-state file lock
~~~

Lower layers must never acquire the operation lock after taking a file lock.

No-write previews do not acquire the operation lock and must not create parent directories, store
files, or sync state. Their reads may observe either side of a concurrent atomic replacement, so a
preview is advisory and a later write-capable operation re-reads state under its operation lock.

Atomic rename is not a multi-file database transaction. Store, sync-state, and dotenv files are
individually crash-safe, but a process or machine failure between files may require a fresh plan and
baseline reconciliation. This limitation must remain documented unless persistence becomes a true
transactional store.

Persisted Vault record and sync-state compatibility is separate from API compatibility. Removing a
reader for an old schema requires an explicit migration tool or procedure; it must not be folded
silently into a later breaking export cleanup.

Schema v1 record paths are portable, config-relative strings in storage and absolute paths only in
memory. The storage adapter owns both transformations. Application code must never persist its
runtime absolute path directly, and readers must reject absolute or platform-specific v1 paths.

## Testing boundaries

Tests should cover three levels where relevant:

- pure/domain behavior;
- application and adapter integration;
- built published entries and real CLI child processes.

Tests must call production registration and wiring rather than reproduce it. Every public package
entry is checked in ESM, CommonJS, and declaration output. Security-sensitive redaction, approval,
selection, error, and concurrency changes require direct regression cases. Format-realistic secret
tests share one locally generated synthetic credential fixture so each credential literal has a
single definition and can never be confused with a provisioned account secret.

Persisted path changes additionally require tests for both POSIX and Win32 semantics plus a
cross-checkout application test. No-write modes require assertions that both existing file content
and absent parent directories remain unchanged.
