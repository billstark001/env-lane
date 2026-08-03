export interface CliBootstrapOptions {
  config?: string
  cwd?: string
  format?: string
  json?: boolean
  prefix?: boolean
}

const VALUE_OPTIONS = new Set(['-b', '--build', '-c', '--config', '--cwd', '--format', '--run-cwd'])

function optionValue(argument: string, longName: string, shortName?: string): string | undefined {
  if (argument.startsWith(`${longName}=`)) return argument.slice(longName.length + 1)
  if (shortName && argument.startsWith(shortName) && argument !== shortName) {
    return argument.slice(shortName.length)
  }
  return undefined
}

function cliArgumentEnd(args: readonly string[]): number {
  const explicitBoundary = args.indexOf('--')
  const boundary = explicitBoundary === -1 ? args.length : explicitBoundary
  let commandIndex = -1

  for (let index = 0; index < boundary; index += 1) {
    const argument = args[index]
    if (VALUE_OPTIONS.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('-')) continue
    commandIndex = index
    break
  }
  if (commandIndex === -1 || args[commandIndex] !== 'run') return boundary

  let targetFound = false
  for (let index = commandIndex + 1; index < boundary; index += 1) {
    const argument = args[index]
    if (VALUE_OPTIONS.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith('-')) continue
    if (!targetFound) {
      targetFound = true
      continue
    }
    return index
  }
  return boundary
}

export function readCliBootstrapOptions(args: readonly string[]): CliBootstrapOptions {
  const options: CliBootstrapOptions = {}
  const end = cliArgumentEnd(args)
  for (let index = 0; index < end; index += 1) {
    const argument = args[index]
    const inlineConfig = optionValue(argument, '--config', '-c')
    const inlineCwd = optionValue(argument, '--cwd')
    const inlineFormat = optionValue(argument, '--format')
    if (inlineConfig !== undefined && options.config === undefined) options.config = inlineConfig
    else if (inlineCwd !== undefined && options.cwd === undefined) options.cwd = inlineCwd
    else if (inlineFormat !== undefined && options.format === undefined)
      options.format = inlineFormat
    else if ((argument === '-c' || argument === '--config') && options.config === undefined) {
      options.config = args[++index]
    } else if (argument === '--cwd' && options.cwd === undefined) options.cwd = args[++index]
    else if (argument === '--format' && options.format === undefined) options.format = args[++index]
    else if (argument === '--json') options.json = true
    else if (argument === '--no-prefix') options.prefix = false
  }
  return options
}
