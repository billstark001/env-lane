import { connect } from 'node:net'

export const PROTOCOL_VERSION = 1
export const MAX_FRAME = 16 * 1024 * 1024

export class PluginError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** Call one registered native API namespace through an env-lane Node binding. */
export function createNativeClient(namespace, binding) {
  if (!namespace || namespace === 'core' || namespace.includes('.') || typeof binding?.invoke !== 'function') {
    throw new PluginError('PLUGIN_PACKAGE_INVALID', 'A plugin namespace and native binding are required.')
  }
  return {
    invoke(method, request) {
      if (!method || typeof method !== 'string') {
        throw new PluginError('INVALID_NATIVE_OPERATION', 'A method name is required.')
      }
      const envelope = JSON.parse(binding.invoke(`${namespace}.${method}`, JSON.stringify(request)))
      if (!envelope.ok) {
        const error = envelope.error ?? {}
        throw new PluginError(error.code ?? 'PLUGIN_PROTOCOL_ERROR', error.message ?? 'Plugin call failed.', error.details)
      }
      return envelope.result
    },
  }
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length > MAX_FRAME) throw new PluginError('PLUGIN_PROTOCOL_ERROR', 'Plugin frame exceeds 16 MiB.')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}

/** Connect to the host and serve requests in order until plugin.shutdown. */
export async function servePlugin({ id, capabilities, handle }) {
  if (!id || !Array.isArray(capabilities) || typeof handle !== 'function') {
    throw new PluginError('PLUGIN_PACKAGE_INVALID', 'id, capabilities, and handle are required.')
  }
  const address = process.env.ENV_LANE_PLUGIN_ADDRESS
  const token = process.env.ENV_LANE_PLUGIN_TOKEN
  if (!address || !token) throw new PluginError('PLUGIN_HANDSHAKE_FAILED', 'Missing host connection.')
  const separator = address.lastIndexOf(':')
  const host = address.slice(0, separator)
  const port = Number(address.slice(separator + 1))
  const socket = connect({ host, port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(frame({ token, protocol: PROTOCOL_VERSION, pluginId: id, capabilities }))
  let buffer = Buffer.alloc(0)
  let pending = Promise.resolve()
  let stopped = false
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0)
      if (size > MAX_FRAME) {
        socket.destroy(new PluginError('PLUGIN_PROTOCOL_ERROR', 'Plugin frame exceeds 16 MiB.'))
        return
      }
      if (buffer.length < size + 4) break
      const payload = buffer.subarray(4, size + 4)
      buffer = buffer.subarray(size + 4)
      pending = pending.then(async () => {
        let request
        try {
          request = JSON.parse(payload.toString('utf8'))
          if (request.jsonrpc !== '2.0' || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') {
            throw new PluginError('PLUGIN_PROTOCOL_ERROR', 'Invalid JSON-RPC request.')
          }
          const result = request.method === 'plugin.shutdown' ? null : await handle(request.method, request.params)
          socket.write(frame({ jsonrpc: '2.0', id: request.id, result }), () => {
            if (request.method === 'plugin.shutdown') socket.destroy()
          })
          if (request.method === 'plugin.shutdown') {
            stopped = true
          }
        } catch (error) {
          const fault = error instanceof PluginError ? error : new PluginError('PLUGIN_HANDLER_FAILED', error instanceof Error ? error.message : String(error))
          if (request?.id !== undefined) socket.write(frame({ jsonrpc: '2.0', id: request.id, error: { code: fault.code, message: fault.message, ...(fault.details === undefined ? {} : { details: fault.details }) } }))
          else socket.destroy(fault)
        }
      })
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('close', () => stopped ? resolve() : reject(new PluginError('PLUGIN_TRANSPORT_FAILED', 'Host disconnected.')))
    socket.once('error', reject)
  })
  await pending
}
