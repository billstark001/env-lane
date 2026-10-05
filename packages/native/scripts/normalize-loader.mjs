import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const packageRoot = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const loaderPath = path.join(packageRoot, 'index.js')
let source = readFileSync(loaderPath, 'utf8')
const staticCheck = `bindingPackageVersion !== '${version}'`
const staticMessage = `expected ${version} but`
if (!source.includes(staticCheck) && !source.includes('const __napiExpectedVersion =')) {
  throw new Error('Generated NAPI loader has an unknown version check format.')
}
source = source.replaceAll(staticCheck, 'bindingPackageVersion !== __napiExpectedVersion')
source = source.replaceAll(staticMessage, 'expected ${__napiExpectedVersion} but')
if (!source.includes('const __napiExpectedVersion =')) {
  source = source.replace(
    "const { readFileSync } = require('fs')",
    "const { readFileSync } = require('fs')\nconst __napiExpectedVersion = require('./package.json').version",
  )
}
if (source.includes(staticCheck) || source.includes(staticMessage) || !source.includes('const __napiExpectedVersion =')) {
  throw new Error('Failed to derive the NAPI loader version from package metadata.')
}
writeFileSync(loaderPath, source)
