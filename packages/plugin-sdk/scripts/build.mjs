import { copyFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../../..')
copyFileSync(path.join(root, 'crates/env-lane-plugin-api/schema/protocol.schema.json'), path.join(root, 'packages/plugin-sdk/protocol.schema.json'))
copyFileSync(path.join(root, 'crates/env-lane-plugin-api/schema/package.schema.json'), path.join(root, 'packages/plugin-sdk/package.schema.json'))
const schema = JSON.parse(readFileSync(path.join(root, 'packages/plugin-sdk/package.schema.json'), 'utf8'))
const protocol = schema.properties.envLanePlugin.properties.protocolVersion.const
const source = readFileSync(path.join(root, 'packages/plugin-sdk/src/index.ts'), 'utf8')
const declared = Number(source.match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1])
const rust = readFileSync(path.join(root, 'crates/env-lane-plugin-api/src/lib.rs'), 'utf8')
const native = Number(rust.match(/pub const PROTOCOL_VERSION: u32 = (\d+);/)?.[1])
if (declared !== protocol || native !== protocol) throw new Error(`Plugin protocol versions differ: SDK ${declared}, Rust ${native}, schema ${protocol}.`)
