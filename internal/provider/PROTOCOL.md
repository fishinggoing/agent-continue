# DeepSeek adapter contract

Protocol ID: `deepseek-chat-completions-v1`. Schema freeze: 2026-10-05.

Primary sources inspected over HTTPS on that date:

- https://api-docs.deepseek.com/quick_start
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/quick_start/error_codes

The current documented models are `deepseek-flash` and `deepseek-v4-pro`.
The adapter selects one configured model and explicitly sends
`thinking: {"type":"disabled"}`. Thinking history, images, beta strict tools,
Anthropic messages, remote model discovery and automatic provider switching
are outside this adapter's implemented contract.

## Request

POST the full configured `/chat/completions` or `/v1/chat/completions` URL.
Use HTTPS, except HTTP loopback for local fixtures. Reject endpoint userinfo,
query strings and fragments. Never follow redirects. Bearer authentication
comes exclusively from the named environment variable, separate from the
web access token. No credential is serialized in configuration.

Send `model`, `messages`, `stream: true`, `stream_options.include_usage: true`,
`max_tokens`, explicit non-thinking mode, and optional function declarations.
Only text content is implemented. Assistant tool calls use stringified JSON
arguments; tool feedback uses `role: tool` and `tool_call_id`. Reject orphan,
duplicate and unresolved history calls before making a request.

## Stream

Require `text/event-stream`. Decode SSE event boundaries independently from
TCP chunks; support UTF-8 byte splits, CRLF, comments and multiple data lines.
Each JSON chunk has a stable ID, `object: chat.completion.chunk`, exactly one
choice with index 0, and an assistant delta. Tool fragments are assembled by
their bounded index; the first fragment has an ID, type `function` and name.
Later argument fragments do not change that identity. Up to 128 calls are
accepted and returned in index order. Final arguments must be JSON objects.
They remain untrusted proposals for registry validation and permission checks.

The official DeepSeek contract puts usage in the final finish-reason chunk,
which has one choice. It does not use a separate empty-choices usage chunk.
Both a finish reason and `data: [DONE]` are required for a complete response.
Only `stop` and `tool_calls` yield success. `length` yields a limit error,
`content_filter` a rejection, and `aborted` / `insufficient_system_resource`
an interrupted stream. Any failure removes all returned tool proposals.

Missing usage counters stay `null`, and explicit zero stays zero. Validate
nonnegative safe integers, aggregate totals and supplied cache/reasoning
relationships. Do not invent counters from text length or calculate billing.

## Limits, Errors And Retry

Configuration sets per-event, total response, request/context, output token,
HTTP timeout, retry count and delay limits. HTTP attempts, including failed
transport attempts, are counted when `http.Client.Do` is called; this count
does not imply that the provider received or billed every attempt.

401/403: authentication; 402: quota; 429: rate limit; 408/504: timeout;
400/404/405/415/422: unsupported protocol; other 5xx: server error.
Only 429, 500, 502, 503 and 504 are retried, at most the configured count.
Retry-After / exponential delay is capped at 60 seconds and is cancellable.
Transport failures and any entered stream are never retried automatically.
Partial responses remain incomplete and cannot be silently combined.
Cancellation closes the HTTP request and interrupts retry waiting.

Errors never include response bodies or headers. Reflected credentials are
redacted from text across delta boundaries; reflected keys in tool arguments,
names or IDs are rejected. The adapter never starts a subprocess.

## Verification Environment

All automatic tests use `httptest` loopback services and synthetic credentials.
External model requests: zero. Remote model quota budget: zero for these tests.
`testdata/text.sse` is a synthetic protocol fixture, not an account transcript.
Tests verify requests, tool declarations/history, fragmented streams, missing
terminators, malformed data, unknown usage, HTTP failures, bounded retry,
size limits, cancellation, timeout, redirection and credential reflection.

A real account, its actual model access and a user-specified spending ceiling
have not been validated. J09 remains pending; local fixtures do not replace it.
