export const PROTOCOL_VERSION: 1
export const MAX_FRAME: number
export type Capability =
  | { kind: 'command'; name: string }
  | { kind: 'nativeApi'; namespace: string }
  | { kind: 'documentFilter' }
  | { kind: 'envSource' }
  | { kind: 'envGenerate' }
  | { kind: 'filePlan' }
export class PluginError extends Error {
  code: string
  details?: unknown
  constructor(code: string, message: string, details?: unknown)
}
export interface NativeBinding {
  invoke(operation: string, request: string): string
}
export interface NativeClient<Methods extends Record<string, { request: unknown; result: unknown }>> {
  invoke<Method extends keyof Methods & string>(method: Method, request: Methods[Method]['request']): Methods[Method]['result']
}
export function createNativeClient<Methods extends Record<string, { request: unknown; result: unknown }>>(
  namespace: string,
  binding: NativeBinding,
): NativeClient<Methods>
export interface PluginDefinition {
  id: string
  capabilities: Capability[]
  handle(method: string, params: unknown): unknown | Promise<unknown>
}
export function servePlugin(definition: PluginDefinition): Promise<void>
