# Contributing

## Requirements

- Node.js 22 or newer
- pnpm matching the workspace lockfile

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
~~~

`pnpm check` is the release gate. It runs lint, type checking, all tests, a clean package build,
published-entry checks, and built CLI child-process tests.

Use `pnpm dev -- <arguments>` to run the local CLI through TypeScript:

~~~bash
pnpm dev -- files . --build local
~~~

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
package exports, Commander registration, streams, process arguments, or built artifacts.

Do not copy production wiring into tests. Avoid shared global state where possible; restore
`process.cwd()`, TTY stubs, environment variables, and temporary files in cleanup hooks.

Security-sensitive changes should test:

- default redaction and explicit secret display;
- structured error codes/details;
- Vault plan freshness and complete decision coverage;
- selection and delete defaults;
- concurrent or stale writes where persistence is involved.

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

1. Update the root and all publishable package versions.
2. Update `CHANGELOG.md` and migration/deprecation documentation.
3. Run `pnpm check`.
4. Run `pnpm pack:dry-run` and inspect package contents.
5. Run `pnpm release:dry-run`.
6. Publish with `pnpm release` or the release workflow.

`pnpm check` already includes a build, so a second standalone build is optional rather than a
release requirement.
