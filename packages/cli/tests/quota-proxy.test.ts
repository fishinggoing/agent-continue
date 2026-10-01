import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createQuotaProxy } from './quota-proxy.ts'

test('quota gate forwards a stream until armed, then refuses without contacting upstream', async () => {
  let calls = 0
  const upstream = createServer(async (incoming, outgoing) => {
    calls++
    assert.equal(incoming.url, '/real/v1/responses')
    assert.equal(incoming.headers.authorization, 'Bearer synthetic-not-a-credential')
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { model: 'synthetic', stream: true })
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.write('data: {"first":true}\n\n')
    setTimeout(() => outgoing.end('data: {"last":true}\n\n'), 10)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createQuotaProxy(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/real/v1`)
  try {
    const input = { method: 'POST', headers: { authorization: 'Bearer synthetic-not-a-credential', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic', stream: true }) }
    const forwarded = await fetch(`${proxy.baseUrl}/responses`, input)
    assert.equal(forwarded.status, 200)
    assert.equal(await forwarded.text(), 'data: {"first":true}\n\ndata: {"last":true}\n\n')
    proxy.denyQuota()
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await fetch(`${proxy.baseUrl}/responses`, input)
      assert.equal(refused.status, 429)
      assert.equal((await refused.json() as any).error.code, 'insufficient_quota')
    }
    assert.equal(calls, 1, 'No real requests after the checkpoint')
    assert.deepEqual(proxy.snapshot(), { denied: true, observations: [
      { phase: 'forwarded', statusCode: 200 }, { phase: 'quota-refused', statusCode: 429 }, { phase: 'quota-refused', statusCode: 429 },
    ] })
    assert.ok(!JSON.stringify(proxy.snapshot()).includes('synthetic-not-a-credential'), 'Receipt must not capture request headers or bodies')
    assert.equal((await fetch(`${proxy.baseUrl}/responses`)).status, 404)
    assert.equal((await fetch(`${proxy.baseUrl}/other`, input)).status, 404)
    assert.equal(calls, 1)
  } finally {
    await proxy.close()
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('quota gate does not accept credentials or query parameters in upstream URLs', async () => {
  for (const url of ['file:///secret', 'http://username:password@localhost/v1', 'http://localhost/v1?api_key=secret']) {
    await assert.rejects(createQuotaProxy(url))
  }
})
