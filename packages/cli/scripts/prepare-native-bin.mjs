import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const destination = path.join(root, 'packages/cli/dist/env-lane')
const diagnostic =
  'env-lane: native CLI was not installed; reinstall with package lifecycle scripts enabled.'
// No shebang: npm and pnpm must generate direct-execution bin shims. The
// postinstall hook replaces this placeholder with the host-native executable.
// If postinstall is blocked, the command fails instead of running a binary
// for the release runner's architecture.
writeFileSync(destination, `printf '%s\\n' '${diagnostic}' >&2\nexit 126\n`)
chmodSync(destination, 0o755)
writeFileSync(`${destination}.cmd`, `@echo off\r\n>&2 echo ${diagnostic}\r\nexit /b 126\r\n`)
