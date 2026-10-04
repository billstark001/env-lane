import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// No shebang: npm's Windows cmd shim invokes the installed native executable directly.
const file = path.resolve(import.meta.dirname, '../dist/env-lane')
writeFileSync(file, '')
chmodSync(file, 0o755)
