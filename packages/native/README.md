# @env-lane/native

Rust Node-API application binding for `@env-lane/core` and `@env-lane/vault`. The package
selects an optional platform addon at runtime. Platform packages also contain the standalone
`env-lane` executable, which the npm CLI installer copies to its bin path.

Build locally with `pnpm --filter @env-lane/native build`.
