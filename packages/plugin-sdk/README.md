# @env-lane/plugin-sdk

A Node.js plugin supplies `envLanePlugin` metadata in its package.json and calls `servePlugin` from its entry file. The host starts it with Node on every platform and the SDK handles the authenticated framed JSON-RPC connection.

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

Use `envLanePlugin: { protocolVersion: 1, id: 'example', capabilities: [...], entry: { kind: 'node', path: './plugin.mjs' } }` in the package manifest and `example: { enabled: true, configFile: 'env-lane.example.json', packageName: '@you/env-lane-example' }` in the main config. The package metadata and handshake capabilities must match exactly.

For a Node API facade, use `createNativeClient` with `@env-lane/native` and declare method
request/result types. The helper adds the registered namespace, decodes the response envelope,
and raises `PluginError` with the native error code. See the
[package metadata schema](./package.schema.json) and [protocol schema](./protocol.schema.json).
