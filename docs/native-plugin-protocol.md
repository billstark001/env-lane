# Plugin packages and process protocol (0.5.0)

Core owns only its commands, the main configuration, package discovery, capability checks, and the process boundary. Vault is a plugin. A declarative Core command runs in Rust without starting Node or a plugin process. An enabled plugin starts only when a command, native API operation, or configured hook uses it.

## Main configuration

The reserved top-level fields are `selector`, `workspace`, `dotenv`, `output`, `sort`, `checks`, and `sync`. Every other field is a plugin registration. Invalid unknown fields fail validation.

```json
{
  "vault": { "enabled": true, "configFile": "env-lane.vault.json" },
  "example": {
    "enabled": true,
    "configFile": "env-lane.example.json",
    "packageName": "@acme/env-lane-example"
  }
}
```

`enabled` is required and is a real gate. A disabled plugin is not resolved or started. Every nonbuilt-in plugin needs a nonempty `configFile` and `packageName`. Vault alone has table defaults: `@env-lane/vault` and `env-lane.vault`. `configFile` is relative to the project root. A plugin owns the schema of its own file. Its registration may enable `documentFilter`, `filterLookup`, `sourceKeys`, `generators`, `replaceFileValues`, and `settings`; the host validates those declared hook capabilities before use. The old `plugins: []` form is removed.

## Package metadata

The host finds `<packageName>/package.json` in the project's `node_modules` hierarchy. Standalone distributions put the same packages under `plugins/<packageName>/`. A test or custom distribution can set `ENV_LANE_PLUGIN_PACKAGE_ROOT` to a directory containing either layout. No package script is executed during discovery.

```json
{
  "name": "@acme/env-lane-example",
  "version": "0.5.0",
  "envLanePlugin": {
    "protocolVersion": 1,
    "id": "example",
    "capabilities": [
      { "kind": "command", "name": "example" },
      { "kind": "nativeApi", "namespace": "example" }
    ],
    "entry": { "kind": "node", "path": "./plugin.mjs" }
  }
}
```

A Rust plugin uses a native entry instead:

```json
{
  "kind": "native",
  "platforms": {
    "darwin-arm64": {
      "package": "@acme/env-lane-example-darwin-arm64",
      "path": "./plugin"
    }
  }
}
```

The eight platform keys used by the release are `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-arm64-musl`, `linux-x64-gnu`, `linux-x64-musl`, `win32-arm64-msvc`, and `win32-x64-msvc`. The native package should be an optional dependency of the main plugin package. Entry paths must resolve to files inside their packages. The protocol version, field/ID, and exact declared capabilities are checked before dispatch. Duplicate command names and native namespaces fail. A missing or malformed package uses `PLUGIN_*` errors. Unknown Node operations use `INVALID_NATIVE_OPERATION`.

For npm/pnpm, install the plugin package and configure its root field. For a standalone archive, preserve `env-lane` and `plugins/` together. A JS plugin needs Node only when that plugin runs; a native plugin and declarative config do not.

## Authoring

Rust plugins depend on `env-lane-plugin-api` and implement `Handler`; call `process::serve(&manifest, &mut handler)`. The crate supplies typed messages, framing, handshake, and capability enforcement. The Vault implementation is a complete example in `crates/env-lane-plugin-vault/`.

A Node plugin depends on `@env-lane/plugin-sdk`:

```js
import { servePlugin } from '@env-lane/plugin-sdk'

await servePlugin({
  id: 'example',
  capabilities: [{ kind: 'command', name: 'example' }],
  async handle(method, params) {
    if (method === 'command.invoke') return { exitCode: 0 }
    throw new Error(`Unsupported method: ${method}`)
  },
})
```

The SDK launches through `node <entry path>` on Windows and Unix; a shebang is unnecessary. The package's `capabilities` must exactly match those passed to `servePlugin`. A command receives `arguments` (including its command name), common options, invocation cwd, project root, main config path, and plugin config path. The plugin parses its own options. `native.invoke` receives `{ operation, request }`; register a `nativeApi` namespace in the package metadata for this method. `createNativeClient` supplies a typed namespace caller for Node facades. `command.invoke`, `document.filter`, `env.source`, `env.generate`, and `file.plan` are capability guarded.

## Wire format

The host opens a loopback socket, starts the plugin with `ENV_LANE_PLUGIN_ADDRESS` and a random `ENV_LANE_PLUGIN_TOKEN`, and requires a hello containing that token, protocol version 1, ID, and exact capabilities. It then exchanges JSON-RPC 2.0 messages in frames with a four-byte little-endian length and at most 16 MiB of UTF-8 JSON. `plugin.shutdown` closes a successful session. Standard terminal streams are inherited for interactive commands. The [protocol schema](../crates/env-lane-plugin-api/schema/protocol.schema.json) and [package metadata schema](../crates/env-lane-plugin-api/schema/package.schema.json) are copied into the published npm SDK.

For hooks, the host passes finite key allowlists and checks returned keys and line ranges. `document.filter` returns one-based inclusive ranges to mask before the Rust dotenv parser runs. `file.plan` only proposes patches; the host validates paths and digests, and an explicit caller must apply them. Sensitive values are redacted in `print` and injected in `run`.
