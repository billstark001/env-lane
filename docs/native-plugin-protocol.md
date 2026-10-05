# Native plugin protocol

Native plugins are separate executables. The host links `env-lane-plugin-api`, not the
plugin's implementation or its dependencies. A plugin may link `env-lane-plugin-api` alone;
Vault also links the domain crates it needs for its own work. The host starts a plugin only
when an enabled capability is used. A native declarative config and a plain `run` therefore do
not start Node or a plugin process.

## Registration

Put a JSON manifest beside the plugin executable:

```json
{
  "id": "example",
  "executable": "./env-lane-plugin-example",
  "capabilities": [
    { "kind": "documentFilter" },
    { "kind": "envSource" },
    { "kind": "envGenerate" },
    { "kind": "filePlan" },
    { "kind": "command", "name": "example" }
  ]
}
```

Paths in a manifest are relative to its directory. Register it in the native main
configuration:

```json
{
  "plugins": [{
    "manifest": "./example/plugin.json",
    "documentFilter": true,
    "filterLookup": ["FEATURE_FLAG"],
    "sourceKeys": ["TOKEN"],
    "generators": [{ "group": "paired", "keys": ["PAIR_A", "PAIR_B"] }],
    "settings": { "profile": "development" }
  }]
}
```

The registration explicitly enables each hook; a manifest declaration alone does not run
it. `sourceKeys`, generator keys, and filter lookups are finite allowlists. A source is
queried only when its key is needed; a generator group is called once during resolution.
Plugins can also expose a command, invoked as `env-lane example ...`. Vault remains the
published `env-lane vault ...` command and is supplied by the optional
`@env-lane/vault` package or a sibling native executable. Its Node package calls the same
plugin executable through the existing Node API facade.

## Process and wire boundary

The host binds a loopback socket and starts the executable with
`ENV_LANE_PLUGIN_ADDRESS` and a random `ENV_LANE_PLUGIN_TOKEN`. The plugin connects and
sends a hello containing the token, protocol version `1`, ID, and exact capabilities.
The host verifies the hello against the manifest. Standard input, output, and error remain
attached to the terminal, so interactive commands can prompt and print normally.

Each socket frame is a 4-byte little-endian length followed by a UTF-8 JSON object, at
most 16 MiB. Requests and responses use JSON-RPC 2.0 fields (`jsonrpc`, `id`,
`method`, `params`, `result`, `error`). The method payloads are typed Rust structs in
`env-lane-plugin-api`; the codec is isolated behind its `Codec` trait. A future transport
format can replace that implementation without changing capability handlers. The current
client serializes typed parameters directly and the server borrows raw JSON parameters,
avoiding an intermediate JSON value tree on the common request path.

Methods are `command.invoke`, `native.invoke`, `document.filter`, `env.source`,
`env.generate`, `file.plan`, and `plugin.shutdown`. A process lives for one host
invocation and can answer multiple calls. An error keeps its code, message, and optional
details. The host rejects an undeclared method, a mismatched handshake or response ID,
an oversized frame, and invalid returned keys or line ranges.

## Resolution semantics

`document.filter` returns one-based inclusive line ranges to disable. The host masks the
text while preserving line endings and line count, then parses it with the existing Rust
dotenv parser. The plugin does not need to implement dotenv quoting or duplicate-key
rules. The lookup input reveals only whether configured keys exist in earlier dotenv files,
the process, or a registered source, never their values.

The host merges dotenv files in their configured order, then plugin source and generated
values, then the process environment if enabled, and finally the build selector. By
default a plugin fills missing file keys; `replaceFileValues` allows it to replace those
keys. Process values and the selector retain their precedence. Plugins cannot provide the
selector key. A returned value marked `sensitive` is redacted by `print` unless secrets
are explicitly requested; `run` injects its actual value.

`env.generate` receives a group and its requested keys together. This lets one invocation
produce correlated values for several environment variables. `file.plan` is a planning
capability: it returns patches for explicitly supplied files with expected SHA-256
digests. The host validates the file allowlist, key/value syntax, duplicate patches,
and digest syntax. No general CLI file-plan apply command is
exposed yet; a future caller must recheck the digests and apply the reviewed plan.

Native config and native plugins need no Node runtime. Executable JS/TS config still
uses the separately invoked compatibility compiler or runner. The published Node APIs
retain their JavaScript facade and Node-API binding; Vault's native behavior now runs in
the optional plugin process.
