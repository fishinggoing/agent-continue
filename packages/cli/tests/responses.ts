import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const CONTINUATION_REPLY = 'LOCAL SYNTHETIC CONTINUATION'

export interface ResponsesFixture {
  baseUrl: string
  requests: Record<string, unknown>[]
  credentialHeaderPresent: boolean
}

export async function withResponsesFixture(
  steps: (fixture: ResponsesFixture) => Promise<void>,
  usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
): Promise<void> {
  const fixture: ResponsesFixture = { baseUrl: '', requests: [], credentialHeaderPresent: false }
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) throw new Error('Local fixture input is too large')
        chunks.push(Buffer.from(chunk))
      }
      fixture.credentialHeaderPresent ||= request.headers.authorization !== undefined || request.headers['api-key'] !== undefined
      fixture.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const id = `msg_fixture_${fixture.requests.length}`
      const message = { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: CONTINUATION_REPLY, annotations: [] }] }
      const events = [
        { type: 'response.created', response: { id: `resp_fixture_${fixture.requests.length}`, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: CONTINUATION_REPLY },
        { type: 'response.output_text.done', item_id: id, output_index: 0, content_index: 0, text: CONTINUATION_REPLY },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: { id: `resp_fixture_${fixture.requests.length}`, status: 'completed', output: [message], usage } },
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
