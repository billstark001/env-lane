// Parse only env-lane's argv. The first child command after `run TARGET`
// owns every following word, including flags named --config.
const valuedFlags = new Set(['-b', '--build', '-c', '--config', '--cwd', '--format', '--run-cwd'])

export function inspectRunnerArguments(args) {
  const options = {}
  let operation
  let runPositionals = 0
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--') break
    if (operation === 'run' && runPositionals >= 1 && !argument.startsWith('-')) break
    if (argument.startsWith('-c') && !argument.startsWith('--') && argument !== '-c') {
      options.configFile = argument.slice(2)
      continue
    }
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (valuedFlags.has(flag)) {
      const value = equals === -1 ? args[++index] : argument.slice(equals + 1)
      if (flag === '-c' || flag === '--config') options.configFile = value
      if (flag === '--cwd') options.cwd = value
      continue
    }
    if (argument.startsWith('-')) continue
    if (operation === undefined) operation = argument
    else if (operation === 'run') runPositionals++
  }
  return { operation, ...options }
}
