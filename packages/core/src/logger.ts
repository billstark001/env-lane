export interface Logger {
  log(message: any, ...args: any[]): void
  info(message: any, ...args: any[]): void
  warn(message: any, ...args: any[]): void
  error(message: any, ...args: any[]): void
  success(message: any, ...args: any[]): void
  debug(message: any, ...args: any[]): void
  /** For interactive prompts or raw stdout writes */
  write(message: string): void
}

let currentLogger: Logger = {
  log: (...args) => console.log(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  success: (...args) => console.log(...args),
  debug: (...args) => console.debug(...args),
  write: (msg) => process.stdout.write(msg),
}

export function setLogger(logger: Logger) {
  currentLogger = logger
}

export function getLogger(): Logger {
  return currentLogger
}
