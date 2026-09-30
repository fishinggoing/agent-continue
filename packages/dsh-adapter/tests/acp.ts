/**
 * Minimal ACP client for driving a real DSH process in tests.
 *
 * DSH's ACP profile speaks newline-delimited JSON-RPC over stdio. `session/list`
 * and `session/resume` issue no model request, which makes them a free, offline
 * oracle for artifacts this package writes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** A parsed JSON-RPC response, keeping the error object as-is. */
interface Response {
  id?: number
  result?: Record<string, unknown>
  error?: unknown
}

/** One configured ACP connection. */
export interface AcpOptions {
  /** Path to the `dsh.cmd` launcher. */
  cli: string
  /** `DSH_HOME` of the isolated harness home to boot against. */
  home: string
  /** Profile name inside that home. */
  profile: string
  /** Milliseconds to wait for each step. */
  timeoutMs?: number
}

/**
 * Boot an ACP profile and drive a few requests against it.
 * @param options - launcher, home, and profile.
 * @param steps - receives a call function; resolves when it returns.
 * @returns the value returned by `steps`.
 */
export async function withAcp<T>(
  options: AcpOptions,
  steps: (call: (method: string, params: unknown) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const child: ChildProcessWithoutNullStreams = spawn('cmd.exe', ['/c', options.cli, options.profile], {
    env: { ...process.env, DSH_HOME: options.home },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  const pending = new Map<number, (response: Response) => void>()
  const stderr: string[] = []
  let nextId = 1
  let buffer = ''
  let exited = false

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message: Response
      try {
        message = JSON.parse(line) as Response
      } catch {
        continue
      }
      if (message.id === undefined) continue
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr.push(String(chunk)) })
  child.on('exit', () => { exited = true })

  const call = (method: string, params: unknown): Promise<Response> => {
    const id = nextId++
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`ACP ${method} timed out after ${options.timeoutMs ?? 60_000}ms${stderr.length ? `; stderr: ${stderr.join('').slice(0, 400)}` : ''}`))
      }, options.timeoutMs ?? 60_000)
      pending.set(id, (response) => { clearTimeout(timer); resolve(response) })
      if (exited) { clearTimeout(timer); reject(new Error(`ACP process exited before ${method}`)) ; return }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  try {
    const init = await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'agent-continue-test', version: '0.0.1' },
    })
    if (init.error) throw new Error(`ACP initialize failed: ${JSON.stringify(init.error)}`)
    return await steps(call)
  } finally {
    try { child.kill() } catch { /* already gone */ }
  }
}
