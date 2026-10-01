import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'

export async function createQuotaProxy(upstreamBase: string) {
  const upstream = new URL(`${upstreamBase.replace(/\/$/, '')}/responses`)
  assert.ok(['http:', 'https:'].includes(upstream.protocol) && !upstream.username && !upstream.password)
  assert.ok(!upstream.search && !upstream.hash, 'Upstream base must not contain query parameters or fragments')
  let denied = false
  let active = 0
  const observations: { phase: 'forwarded' | 'quota-refused'; statusCode: number }[] = []
  const connections = new Set<ReturnType<typeof httpRequest>>()
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method !== 'POST' || incoming.url !== '/v1/responses') {
      incoming.resume()
      outgoing.writeHead(404).end()
      return
    }
    if (denied) {
      incoming.resume()
      observations.push({ phase: 'quota-refused', statusCode: 429 })
      outgoing.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { message: 'Synthetic acceptance quota exhausted. Source model unavailable; continue with another harness.',
          type: 'insufficient_quota', param: null, code: 'insufficient_quota' },
      }))
      return
    }
    active++
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of incoming) {
        bytes += chunk.length
        if (bytes > 8 * 1024 * 1024) throw new Error('Fixture request exceeds its limit')
        chunks.push(Buffer.from(chunk))
      }
      const headers = { ...incoming.headers }
      for (const name of ['host', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'te', 'trailer']) delete headers[name]
      const body = Buffer.concat(chunks)
      headers['content-length'] = String(body.length)
      await new Promise<void>((resolve, reject) => {
        const request = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(upstream, { method: 'POST', headers }, (response) => {
          observations.push({ phase: 'forwarded', statusCode: response.statusCode ?? 502 })
          const responseHeaders = { ...response.headers }
          for (const name of ['connection', 'transfer-encoding', 'keep-alive']) delete responseHeaders[name]
          outgoing.writeHead(response.statusCode ?? 502, responseHeaders)
          response.once('error', reject)
          response.once('end', resolve)
          response.pipe(outgoing)
        })
        connections.add(request)
        request.once('close', () => connections.delete(request))
        request.once('error', reject)
        request.setTimeout(180_000, () => request.destroy(new Error('Fixture upstream timeout')))
        outgoing.once('close', () => request.destroy())
        request.end(body)
      })
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { message: 'Acceptance upstream transport failed' } }))
    } finally { active-- }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    denyQuota() {
      assert.equal(active, 0, 'Cannot inject refusal during an in-flight model request')
      denied = true
    },
    snapshot: () => ({ denied, observations: observations.map((item) => ({ ...item })) }),
    async close() {
      for (const request of connections) request.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
