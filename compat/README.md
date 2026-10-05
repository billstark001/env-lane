# 0.4.2 compatibility baseline

This directory is the language-neutral migration boundary for the native rewrite. It freezes
observable 0.4.2 behavior without making the TypeScript source tree the oracle.

- `contracts/v0.4.2.json` records public entry points, runtime exports, CLI syntax, defaults,
  errors, persisted schemas, and the future implementation owner of each contract.
- `oracle/v0.4.2/` contains a self-contained Node 0.4.2 runtime artifact and its SHA-256.
- `fixtures/cases/` contains runner-neutral operations and golden observations.
- `fixtures/dotenv/` contains parser, renderer, patch, and generated-regression corpus data.
- `fixtures/topologies/` contains synthetic versions of the two real downstream layouts.
- `fixtures/vault/` contains synthetic keys and encrypted schema fixtures only. No real secret or
  checkout data is allowed here.

## Boundary policy

`rust-core` means durable domain/application behavior that should have one Rust implementation.
`native-cli` means behavior owned by the native executable boundary. `node-compat` means a
published compatibility promise that must remain outside Rust: JavaScript configuration loading,
Commander registration, AsyncLocalStorage diagnostics, JS identity helpers, deprecated adapters,
and Node callback/Promise shaping. `shared-protocol` identifies data that Rust and all facades must
read or write identically.

Compatibility-only does not mean optional during the 0.4.x migration window. It means the behavior
is preserved by the outer API instead of being copied into the Rust domain model.

## Commands

```sh
pnpm compat:oracle:verify
pnpm compat:classify
pnpm compat:fixtures
pnpm compat:verify
```

`pnpm compat:oracle:capture` is intentionally guarded and rebuilds from the immutable `v0.4.2`
tag in a temporary checkout. It is not part of normal test runs.

The future Rust runner must consume the same case files and emit the observation format defined by
`fixtures/protocol.schema.json`. Random Vault ciphertext is compared by cross-decrypting records,
not by comparing random bytes.
