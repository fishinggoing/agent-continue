import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RpcResponse {
  result?: Record<string, unknown>
  error?: unknown
}

export interface RpcNotification {
  method: string
  params?: Record<string, unknown>
  id?: number | string
}

export function nativeCliVersion(binary: string): string {
  const output = execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
  const matched = /^codex-cli (\S+)$/.exec(output)
  if (matched === null) throw new Error('Native Codex binary returned an unrecognized version')
  return matched[1]!
}

export function configureHome(home: string, baseUrl = 'http://127.0.0.1:9/v1'): void {
  mkdirSync(home)
  writeFileSync(join(home, 'config.toml'), [
    'model = "offline-probe"', 'model_provider = "local-probe"',
    'sandbox_mode = "read-only"', 'approval_policy = "on-request"',
    '[model_providers.local-probe]', 'name = "Local native verification"',
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"', 'requires_openai_auth = false', '',
  ].join('\n'))
}

export async function withRpcServer(
  binary: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  steps: (call: (method: string, params: unknown) => Promise<RpcResponse>, notifications: RpcNotification[], notify: (method: string, params: unknown) => void) => Promise<void>,
): Promise<void> {
  const server = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map<number, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const notifications: RpcNotification[] = []
  let nextId = 0
  let buffer = ''
  const fail = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }
  server.on('error', fail)
  server.on('exit', () => fail(new Error('Native probe exited before completing its requests')))
  server.stdin.on('error', fail)
  server.stderr.resume()
  server.stdout.setEncoding('utf8')
  server.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let boundary: number
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      let message: RpcResponse & { id?: number | string; method?: string; params?: Record<string, unknown> }
      try { message = JSON.parse(line) } catch { continue }
      if (message.method !== undefined) {
        notifications.push(message as RpcNotification)
        continue
      }
      if (typeof message.id !== 'number') continue
      const entry = pending.get(message.id)
      if (entry === undefined) continue
      clearTimeout(entry.timer)
      pending.delete(message.id)
      entry.resolve(message)
    }
  })
  const call = (method: string, params: unknown): Promise<RpcResponse> => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Native probe timed out during ${method}`))
    }, 20_000)
    pending.set(id, { resolve, reject, timer })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => { if (error) fail(error) })
  })
  try {
    await steps(call, notifications, (method, params) => { server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`) })
  } finally {
    fail(new Error('Native probe finished'))
    server.stdin.end()
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (server.exitCode === null && server.signalCode === null && server.pid !== undefined) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }, resolve))
      } else server.kill()
    }
  }
}

export async function withServer(
  binary: string,
  home: string,
  cwd: string,
  steps: (call: (method: string, params: unknown) => Promise<RpcResponse>, notifications: RpcNotification[]) => Promise<void>,
): Promise<void> {
  await withRpcServer(binary, ['app-server', '--listen', 'stdio://'], {
    CODEX_HOME: home, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME,
    TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
  }, cwd, async (call, notifications, notify) => {
    const initialized = await call('initialize', {
      clientInfo: { name: 'agent_continue_native_test', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    })
    assert.equal(initialized.error, undefined)
    notify('initialized', {})
    await steps(call, notifications)
  })
}

export async function waitForNotification(
  notifications: readonly RpcNotification[],
  predicate: (notification: RpcNotification) => boolean,
  timeoutMs = 30_000,
): Promise<RpcNotification> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const matched = notifications.find(predicate)
    if (matched !== undefined) return matched
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Native probe timed out waiting for the expected notification')
}
