import { copyFileSync } from 'node:fs'

const [source, destination] = process.argv.slice(2)

if (!source || !destination) {
  throw new Error('Usage: node scripts/copy-file.mjs <source> <destination>')
}

copyFileSync(source, destination)
