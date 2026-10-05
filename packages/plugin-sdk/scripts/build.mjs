import { copyFileSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../../..')
copyFileSync(path.join(root, 'crates/env-lane-plugin-api/schema/protocol.schema.json'), path.join(root, 'packages/plugin-sdk/protocol.schema.json'))
copyFileSync(path.join(root, 'crates/env-lane-plugin-api/schema/package.schema.json'), path.join(root, 'packages/plugin-sdk/package.schema.json'))
