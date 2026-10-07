type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const STYLE_MAP: Record<LogLevel, string> = {
  DEBUG: 'color: #888',
  INFO: 'color: #3b82f6',
  WARN: 'color: #f59e0b',
  ERROR: 'color: #ef4444',
}

let globalLevel: LogLevel = 'WARN'

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

export function setLogLevel(level: LogLevel): void {
  globalLevel = level
}

export function createLogger(module: string) {
  const prefix = `[Pinokio:${module}]`

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[globalLevel]
  }

  function debug(message: string, ...data: unknown[]): void {
    if (!shouldLog('DEBUG')) return
    if (data.length > 0) {
      console.log(`%c${prefix} ${message}`, STYLE_MAP.DEBUG, ...data)
    } else {
      console.log(`%c${prefix} ${message}`, STYLE_MAP.DEBUG)
    }
  }

  function info(message: string, ...data: unknown[]): void {
    if (!shouldLog('INFO')) return
    if (data.length > 0) {
      console.log(`%c${prefix} ${message}`, STYLE_MAP.INFO, ...data)
    } else {
      console.log(`%c${prefix} ${message}`, STYLE_MAP.INFO)
    }
  }

  function warn(message: string, ...data: unknown[]): void {
    if (!shouldLog('WARN')) return
    if (data.length > 0) {
      console.warn(`%c${prefix} ${message}`, STYLE_MAP.WARN, ...data)
    } else {
      console.warn(`%c${prefix} ${message}`, STYLE_MAP.WARN)
    }
  }

  function error(message: string, ...data: unknown[]): void {
    if (!shouldLog('ERROR')) return
    if (data.length > 0) {
      console.error(`%c${prefix} ${message}`, STYLE_MAP.ERROR, ...data)
    } else {
      console.error(`%c${prefix} ${message}`, STYLE_MAP.ERROR)
    }
  }

  function group(label: string): void {
    console.group(`${prefix} ${label}`)
  }

  function groupEnd(): void {
    console.groupEnd()
  }

  return { debug, info, warn, error, group, groupEnd }
}
