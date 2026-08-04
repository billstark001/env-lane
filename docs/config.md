# Configuration reference

Env-lane loads `env-lane.config.ts`, JavaScript ESM/CJS, or JSON through its config loader.
Use `--config <file>` or the API `configFile` option for a non-default name. Relative paths are
resolved from `--cwd`; default config discovery still searches the discovered project root.

~~~ts
import { defineConfig } from '@env-lane/core';

export default defineConfig({
  selector: {
    envKey: 'ENV_BUILD',
    defaultBuild: 'local',
    builds: ['staging', 'production'],
    buildValidation: 'warn',
    forbidInDotenv: true
  },
  workspace: {
    packageGlobs: ['apps/*', 'packages/*'],
    aliases: {
      api: 'apps/api',
      web: '@acme/web'
    },
    defaultTarget: 'api',
    includeRoot: true
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local',
    requireOverride: false,
    includeProcessEnv: true,
    preserveBOM: true,
    eol: 'auto'
  },
  output: {
    format: 'text',
    prefix: true
  },
  sort: {
    api: {
      file: '.env',
      template: '.env.example',
      create: true,
      files: {
        ci: '.env.ci'
      },
      unlistedVariablesComment: 'Variables not present in the template:'
    }
  },
  checks: {
    deploy: {
      sources: {
        api: { target: 'api' },
        web: { target: 'web' }
      },
      rules: [
        { type: 'required', source: 'api', key: 'DATABASE_URL' },
        {
          type: 'equals',
          left: { source: 'web', key: 'VITE_API_ORIGIN' },
          right: { source: 'api', key: 'PUBLIC_API_ORIGIN' },
          transform: 'url-base'
        }
      ]
    }
  },
  sync: {
    webFromApi: {
      from: { target: 'api' },
      to: { target: 'web' },
      mappings: [
        {
          from: 'PUBLIC_API_ORIGIN',
          to: 'VITE_API_ORIGIN',
          transform: 'url-base'
        }
      ]
    }
  },
  vault: {
    enabled: false,
    configFile: 'env-lane.vault',
    disableUnsafeWarning: false
  }
});
~~~

## Selector

| Field | Default | Meaning |
| --- | --- | --- |
| `envKey` | `ENV_BUILD` | Selector injected into the resolved environment. |
| `defaultBuild` | `local` | Build used when the CLI/API and shell provide none. |
| `builds` | `[]` | Known builds; an empty array accepts every valid name. |
| `buildValidation` | `warn` | `off`, `warn`, or `error` for unknown builds. |
| `forbidInDotenv` | `true` | Reject the selector key in managed dotenv files. |

Build names must be safe single path segments. The selector supplied by an explicit API/CLI option
takes precedence over the shell value, which takes precedence over `defaultBuild`.

## Workspace

`workspace.packageGlobs` takes precedence over automatic discovery. Without it, env-lane reads
`pnpm-workspace.yaml`; if none is available, it uses `packages/*` and `apps/*`. npm and Yarn
workspace declarations are not read automatically.

Targets may be package names, relative directories, or keys in `workspace.aliases`. If multiple
packages exist and no target is supplied, configure `defaultTarget` or pass a target explicitly.

## Dotenv

`dotenv.order` is evaluated relative to the selected target. `{build}` is replaced by the
active build except that `localBuildName` maps to `localOverrideFile`.

Later dotenv files override earlier files. When `includeProcessEnv` is true, shell values override
dotenv values. `requireOverride` makes a selected build override mandatory.

All consumers share the same line-level env document model. It preserves BOM, EOL style, comments,
colon separators, inline comments, duplicate entries, and multiline syntax while exposing a
`dotenv`-compatible effective value.

## Sort

Every workspace alias is available as a conventional sort target using `.env` and
`.env.example`. Explicit entries can override `baseDir`, `file`, and `template`, or define
additional named files. A relative `baseDir` is resolved from the project root; `file`, `template`,
and entries in `files` are resolved from that target's `baseDir`.

`create` defaults to true and permits creation of a missing target env file from an existing
template. It never creates a missing template. Set it to false to skip absent target files.

Build names from `selector.builds` are discovered through patterns in `dotenv.order` that
contain `{build}`. Variables absent from the template remain appended; use
`unlistedVariablesComment` to label that section.

## Checks and sync

Check sources use exactly one of `target` or `file`. Rules support:

- `required`: require one key.
- `requiredAny`: require at least one key from a list.
- `equals`: compare two keys, optionally after a transform.

Sync copies configured mappings from one source to one target file. Supported transforms are
`trim`, `lowercase`, `uppercase`, `url-base`, and `url-base-slash`. No transform preserves
the original effective value, including meaningful leading or trailing spaces.

## Output

`output.format` defaults to `text`; `json` is intended for automation and `dotenv` is
supported only where a command has a dotenv renderer. `output.prefix` controls diagnostic
prefixes, not final payloads.

## Vault handoff

The main config only enables the optional CLI integration, controls the unsafe warning, and points
to a dedicated Vault config. See [Vault](vault.md) for the separate schema.

`cli.aliases` is no longer a valid field. It was introduced in 0.3.0 and removed in 0.4.0.
