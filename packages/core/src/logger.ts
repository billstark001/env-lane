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

let prefixEnabled = true

export function setPrefixEnabled(enabled: boolean): void {
  prefixEnabled = enabled
}

export function isPrefixEnabled(): boolean {
  return prefixEnabled
}

export function setLogger(logger: Logger) {
  currentLogger = logger
}

function formatMessage(msg: any): any {
  if (!prefixEnabled && typeof msg === 'string') {
    return msg.replace(/^\[env-lane:vault\]\s*/, '').replace(/^\[env-lane\]\s*/, '')
  }
  return msg
}

export function getLogger(): Logger {
  return {
    log: (msg, ...args) => currentLogger.log(formatMessage(msg), ...args),
    info: (msg, ...args) => currentLogger.info(formatMessage(msg), ...args),
    warn: (msg, ...args) => currentLogger.warn(formatMessage(msg), ...args),
    error: (msg, ...args) => currentLogger.error(formatMessage(msg), ...args),
    success: (msg, ...args) => currentLogger.success(formatMessage(msg), ...args),
    debug: (msg, ...args) => currentLogger.debug(formatMessage(msg), ...args),
    write: (msg) => {
      if (!prefixEnabled && typeof msg === 'string') {
        currentLogger.write(
          msg.replace(/^\[env-lane:vault\]\s*/, '').replace(/^\[env-lane\]\s*/, ''),
        )
      } else {
        currentLogger.write(msg)
      }
    },
  }
}
