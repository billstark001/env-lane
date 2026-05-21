# env-lane

CLI for workspace-aware dotenv injection and development vault helpers.

```bash
pnpm add -D env-lane
```

```bash
env-lane packages
env-lane files api --build production
env-lane print api --build production --format json
env-lane run api --build production -- pnpm start
env-lane check api --build production --require-override
```

The package also re-exports `@env-lane/core` and `@env-lane/vault` APIs for convenience.

See the full documentation at https://github.com/billstark001/env-lane#readme.
