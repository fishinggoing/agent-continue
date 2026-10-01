import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const MESSAGES_REPLY = 'LOCAL COMPACTION PROJECTION CHECK'

export async function withMessagesFixture(steps: (fixture: {
  baseUrl: string
  requests: Record<string, unknown>[]
  unexpectedCredential: boolean
}) => Promise<void>): Promise<void> {
  const fixture = { baseUrl: '', requests: [] as Record<string, unknown>[], unexpectedCredential: false }
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.writeHead(404)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) throw new Error('Local Messages fixture input is too large')
        chunks.push(Buffer.from(chunk))
      }
      fixture.unexpectedCredential ||= request.headers['x-api-key'] !== 'isolated-fake-key' || request.headers.authorization !== undefined
      fixture.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const events = [
        { type: 'message_start', message: { id: `fixture-${fixture.requests.length}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: MESSAGES_REPLY } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end()
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  fixture.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  try { await steps(fixture) } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
