import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { plainValue } from './rust-support.mjs'

// Only the Rust differential test launches this process. Its module path comes
// from withOracle after checksum verification, never from the working TS source.
const legacy = await import(pathToFileURL(process.env.ENV_LANE_ORACLE_DOCUMENT))
const destination = path.join(process.env.ENV_LANE_ORACLE_TEMP, 'fuzz.env')
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
  let result
  if (request.operation === 'parse') {
    const { exists: _exists, ...document } = plainValue(legacy.parseEnvDocument(request.content))
    result = document
  } else {
    writeFileSync(destination, request.content)
    try {
      const { filePath: _path, ...patch } = legacy.applyEnvDocumentPatches(
        destination,
        request.patches,
        request.options,
      )
      result = { ...patch, content: readFileSync(destination, 'utf8') }
    } catch (error) {
      result = { error: error.code }
    }
  }
  process.stdout.write(`${Buffer.from(JSON.stringify(result)).toString('base64')}\n`)
}
