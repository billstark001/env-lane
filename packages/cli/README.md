# env-lane

CLI for workspace-aware dotenv injection and optional development vault helpers.

```bash
pnpm add -D env-lane
```

```bash
env-lane packages
env-lane files api --build production
env-lane print api --build production --format json
env-lane run api --build production -- pnpm start
env-lane check --target api --build production --require-override
env-lane check --policy deploy --build production
env-lane sync webFromApi --build production --dry-run
env-lane sort env-lane.config.ts api production
```

Final command payloads use stdout; diagnostics use stderr. `--json` emits one JSON document on stdout. The `run` command accepts text only because its child owns stdout. Use `--non-interactive` together with explicit approval and conflict policies for agents and CI.

The package also re-exports `@env-lane/core` APIs for convenience.

Vault commands are optional and require installing `@env-lane/vault` alongside `env-lane`.

See the full documentation at https://github.com/billstark001/env-lane#readme.
