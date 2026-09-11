import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { plainValue, runRustExample, withOracle, workspace } from './rust-support.mjs'

const fixture = (name) =>
  JSON.parse(readFileSync(path.join(workspace, `compat/fixtures/dotenv/${name}.json`), 'utf8'))
await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/env-document.js'))
  )
  const requests = []
  const expected = []
  const ids = []
  const add = (id, input, value) => {
    ids.push(id)
    requests.push(input)
    expected.push(value)
  }
  const parse = (id, content) => {
    const { exists: _exists, ...document } = plainValue(legacy.parseEnvDocument(content))
    const values = Object.fromEntries(
      Object.entries(document.currentMap).map(([k, v]) => [k, v.effectiveValue]),
    )
    add(id, { op: 'parse', content }, { document, values })
  }
  for (const c of fixture('effective-values').cases)
    parse(c.id, c.content ?? Buffer.from(c.base64, 'base64').toString('utf8'))
  for (const c of fixture('rust-regressions').cases) parse(c.id, c.content)
  for (const c of fixture('format-values').cases)
    add(
      c.id,
      { op: 'format', value: c.value },
      c.error ? { error: c.error } : { value: c.formatted },
    )
  for (const c of fixture('patches').cases) {
    const file = path.join(temporary, 'patch.env')
    writeFileSync(file, c.initial)
    const { filePath: _path, ...result } = legacy.applyEnvDocumentPatches(
      file,
      c.patches,
      c.options,
    )
    add(
      c.id,
      {
        op: 'patch',
        content: c.initial,
        patches: c.options.sortAdditions
          ? [...c.patches].sort((left, right) => left.key.localeCompare(right.key))
          : c.patches,
        options: c.options,
      },
      { ...result, content: readFileSync(file, 'utf8') },
    )
  }
  const generator = fixture('generator')
  let state = generator.seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const lines = []
  for (let i = 0; i < generator.cases; i++) {
    const key =
      i % generator.duplicateEvery === 0
        ? generator.keys[0]
        : generator.keys[next() % generator.keys.length]
    const quote = generator.quotes[next() % generator.quotes.length]
    const comment = generator.comments[next() % generator.comments.length]
    const base = `value-${i}-${next().toString(16)}`
    let token = comment === 'inside-quote' ? `${base} # literal` : base
    if (quote === 'single') token = `'${token}'`
    else if (quote === 'double') token = `"${token}${i % 11 === 0 ? '\\nnext' : ''}"`
    else if (quote === 'backtick') token = `\`${token}\``
    lines.push(
      `${i % 9 === 0 ? 'export ' : ''}${key}${i % 5 === 0 ? ': ' : '='}${token}${comment === 'inline' ? ' # generated comment' : ''}`,
    )
    parse(`generated-${i}`, lines.join('\n'))
  }
  // Extra deterministic grammar combinations exercise multiline/invalid/escaped input.
  const atoms = [
    'A=',
    'B: ',
    'export A=',
    '# A=',
    'INVALID',
    "'",
    '"',
    '`',
    '#',
    '\\',
    '\\n',
    '\\r',
    '\n',
    '\r\n',
    ' ',
    '🦀',
    '\uFEFF',
    '\u0085',
    '\u2028',
  ]
  for (let i = 0; i < 1000; i++) {
    let content = ''
    const count = next() % 30
    for (let j = 0; j < count; j++) content += atoms[next() % atoms.length]
    parse(`grammar-${i}`, content)
  }
  const actual = runRustExample('document-protocol', requests)
  assert.equal(actual.length, expected.length)
  for (let i = 0; i < actual.length; i++)
    assert.deepEqual(actual[i], expected[i], `${ids[i]} input=${JSON.stringify(requests[i])}`)
  process.stdout.write(
    `Rust document differential: ${actual.length} cases passed against frozen 0.4.2.\n`,
  )
})
