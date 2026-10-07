# Contributing

## Requirements

- Node.js 22 or newer
- pnpm matching the workspace lockfile
- Rust toolchain from `rust-toolchain.toml`

~~~bash
pnpm install
~~~

## Development commands

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:watch
pnpm build
pnpm check
pnpm rust:check
~~~

`pnpm check` is the release gate. It runs lint, type checking, all tests, a clean package build,
published-entry checks, and built CLI child-process tests.

`pnpm rust:check` adds rustfmt, Clippy, Cargo tests, and curated frozen 0.4.2 differential tests. The
standalone CLI is `cargo run --locked -p env-lane-cli -- <arguments>`. The Node binding is built
with `pnpm --filter @env-lane/native build`. Keep `.rewrite/` implementation notes current even
though that directory is ignored by Git. See [native migration](docs/native-migration.md) for
the remaining release gates.

Use `pnpm dev -- <arguments>` to run the local Rust CLI:

~~~bash
pnpm dev -- files . --build local
~~~

The eight `@env-lane/native-*` and eight `@env-lane/vault-native-*` directories are generated
from `scripts/native-targets.mjs` and staged release binaries. They are ignored by Git. Run
`node scripts/compat/platform-packages.mjs` to verify package derivation and npm pack contents
with synthetic binaries; the release workflow runs `node scripts/native-release.mjs prepare` with
the real platform artifacts.

## Change boundaries

Keep dependencies aligned with [Architecture](docs/architecture.md):

- Core does not import Vault or CLI code.
- Vault application/domain/adapters do not import its CLI presentation layer.
- CLI stream, prompt, and exit-code behavior stays in presentation code.
- Package roots expose only intentionally supported symbols.
- Internal imports use source modules; consumers use declared package entries.

Prefer coarse modules with a clear owner. Do not create a new file for every helper, but split code
when responsibilities change independently or dependency direction becomes unclear.

## Tests

Add the narrowest useful regression first, then cover a real public entry when behavior depends on
package exports, the embedded Vault Commander adapter, streams, process arguments, or built artifacts.

Do not copy production wiring into tests. Avoid shared global state where possible; restore
`process.cwd()`, TTY stubs, environment variables, and temporary files in cleanup hooks.

Security-sensitive changes should test:

- default redaction and explicit secret display;
- structured error codes/details;
- Vault plan freshness and complete decision coverage;
- selection and delete defaults;
- concurrent or stale writes where persistence is involved.
- portable persisted paths under both POSIX and Win32 semantics;
- no-write previews that preserve existing files and do not create absent output directories.

## Documentation

Update the focused guide that owns the behavior:

- `README.md`: product overview, quick start, navigation.
- `docs/cli.md`: command syntax, output, exit status.
- `docs/config.md`: main configuration schema and defaults.
- `docs/vault.md`: Vault safety and workflows.
- `docs/api.md`: public entries, deprecations, migrations.
- `docs/architecture.md`: package/layer boundaries and invariants.
- package README files: npm-facing package usage.

Public API additions need export-boundary documentation and published-entry verification.
Deprecated APIs must include a replacement or clearly state that no supported replacement exists.

## Commits

Use Conventional Commits where practical, for example:

~~~text
fix(vault): bind approvals to current plan
feat(api): add stable feature entry
docs: split user and maintainer guides
~~~

Keep unrelated user changes out of a commit. Review staged content with
`git diff --cached --check` and `git diff --cached` before committing.

## Release

Follow [versioning, changelog and publishing](docs/releasing.md). Patch versions are independent:
bump only packages with shipped changes, including dependency-range corrections. Ordinary
internal dependencies use explicit `workspace:^MAJOR.MINOR.PATCH` minimums so later compatible
patches remain installable. Generated platform artifacts retain exact owning-package versions.

Use dated package-name changelog entries for partial updates and a committed `releases/<tag>.json`
plan to select the batch. The tag-driven workflow preserves GitHub OIDC trusted publishing and
publishes only selected packages and their platform families.

`pnpm check` already includes a build, so a second standalone build is optional rather than a
release requirement.
