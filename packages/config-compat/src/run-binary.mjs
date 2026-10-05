import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { constants } from 'node:os'

function directoryExists(cwd) {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function signalStatus(signal) {
  const number = constants.signals[signal]
  return number === undefined ? 1 : 128 + number
}

/** Run the native CLI without buffering its streams or losing signal identity. */
export async function runBinary(binary, args, environment, cwd = process.cwd()) {
  const isolatedGroup =
    process.platform !== 'win32' &&
    !process.stdin.isTTY &&
    !process.stdout.isTTY &&
    !process.stderr.isTTY
  const child = spawn(binary, args, {
    stdio: 'inherit',
    env: environment,
    cwd,
    detached: isolatedGroup,
  })
  const send = (signal) => {
    if (isolatedGroup && child.pid) {
      try {
        process.kill(-child.pid, signal)
      } catch {}
    } else {
      child.kill(signal)
    }
  }
  let receivedSignal
  let killTimer
  const forward = (signal) => {
    if (receivedSignal) return
    receivedSignal = signal
    send(signal)
    killTimer = setTimeout(() => send('SIGKILL'), 5000)
    killTimer.unref()
  }
  const onInterrupt = () => forward('SIGINT')
  const onTerminate = () => forward('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  let spawnError
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  process.off('SIGINT', onInterrupt)
  process.off('SIGTERM', onTerminate)
  if (killTimer) clearTimeout(killTimer)
  if (receivedSignal) {
    process.kill(process.pid, receivedSignal)
    return signalStatus(receivedSignal)
  }
  if (spawnError) {
    const notFound = spawnError.code === 'ENOENT' && directoryExists(cwd)
    process.stderr.write(`Cannot start env-lane binary: ${spawnError.message}\n`)
    return notFound ? 127 : 126
  }
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal)
    return signalStatus(outcome.signal)
  }
  return outcome.code ?? 1
}
