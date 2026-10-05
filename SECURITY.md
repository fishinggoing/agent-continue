# Security and Deployment

Source: code inspection of the HTTP server, task ownership checks, provider adapters, storage and deployment templates. Verification below records measured results; it is not an assessment of an existing remote deployment.

## Network Boundary

External access requires HTTPS and a private `AGENT_CONTINUE_TOKEN` of 24 to 256 characters. Generate a random token (for example, `openssl rand -hex 32`); do not share the administrator token with ordinary users. Create a separate user access code in the administrator's settings for each person.

The HTTP listener belongs behind a TLS reverse proxy. Public HTTP requests are refused. Only direct loopback requests with a loopback Host can use HTTP; tokenless mode is limited to that same boundary to prevent DNS rebinding and accidental public administrator access. Keep port 8080 off the public network. `/healthz` reports only server availability.

Set `AGENT_CONTINUE_TRUSTED_PROXIES` to the exact proxy peer IP CIDRs, separated by commas. The systemd template uses `127.0.0.1/32,::1/128`. For Docker, use the actual proxy/host gateway address as a `/32` (or IPv6 `/128`); do not trust an entire public or container network. The default trusts no proxy. Wildcard CIDRs are rejected.

The proxy must overwrite `X-Forwarded-Proto` with its connection scheme and `X-Real-IP` with its client address, and preserve the public Host including any non-default port. Nginx and Caddy templates perform these operations. `X-Forwarded-Prefix: /ac/` is accepted only from a trusted proxy for cookie scoping. Serve this application on its own origin, or trust every other application hosted on the same origin: URL paths are not browser security boundaries.

The Nginx `/ac/` template redirects HTTP to HTTPS. Install a valid TLS certificate before public use. Testing scripts refuse to send credentials to public HTTP or follow an origin-changing credential redirect.

## Identity and Private Data

All session, event, export, file and approval endpoints check the authenticated user's immutable ownership. A foreign ID returns the same 404 as an unknown ID. The HTTP administrator also sees only their own conversation history; the operating-system administrator remains a trusted party.

Browser logins use independent random credentials with `HttpOnly`, `SameSite=Strict`, and `Secure` on HTTPS. The server retains only their SHA-256 lookup hashes in memory. Logins expire after 12 hours. Logout, replacement login, and user revocation invalidate the applicable credentials and cancel their event streams. A restart requires browser login again; old stateless signed cookies are intentionally rejected. Cookie-authenticated writes require same-origin browser evidence and JSON endpoints reject form/text submissions.

Administrator settings include user access revocation. Revocation disables that user's access code and cookies, closes their existing Bearer and cookie event streams, and cancels their active runs. Historical data remains stored and owned by the revoked identity; recreating the same display name generates a new identity. To replace a compromised administrator token, update the service environment and restart. Rotate any API key that has already been exposed at the provider.

Model keys are configured only by the administrator and shared by the service's model runs. There is currently no per-user model-key store. Keys never appear in model settings responses, conversation snapshots or exports. Provider response/error handling rejects reflected credentials, including JSON-escaped tool arguments; streamed key fragments are redacted. Conversation Markdown is sanitized as HTML, with scripts, remote images and browser forms disabled.

The workbench directory uses mode 0700 and database/settings files use mode 0600 on Unix, including existing files and SQLite sidecars. Credentials and conversations are not encrypted at rest. Keep backup copies private. Unix mode bits do not establish Windows ACL isolation: on Windows, restrict the data directory's NTFS ACL to the service account and administrators. Use a dedicated service OS account and separate data directories for independent deployments. Never serve the data directory through Nginx, Caddy or a file share.

## Resource Limits and Verification

Authentication attempts are limited to 10 per peer IP per minute and 120 globally; trusted proxies may supply the overwritten client IP. API concurrency is bounded at 64 requests. Event streams are limited to two per user and 32 globally. Ordinary users have at most ten sessions and one active run. The existing four-run/100-session global limits reserve one active run and ten session slots for the owner. Rejected starts do not leave uploaded workspaces behind.

Security regression tests use synthetic credentials and conversations, never production secrets or paid model calls:

```sh
go test ./...
go vet ./...
go test -race ./internal/server ./internal/task ./internal/session ./internal/provider
```

`scripts/security-web-smoke.mjs` verifies the actual browser login, user creation/revocation, foreign-session rejection, Markdown sanitization, logout replay and desktop/mobile settings against an isolated local server using its fixed synthetic access token. Linux tests also check database/settings permissions and symlink refusal.

These changes reduce the verified application attack paths. They do not replace HTTPS certificate validation, firewall restrictions, OS access control, patching or protection against traffic that saturates the network before reaching the application.

Measured on 2026-10-05: full Windows Go tests and `go vet` passed, as did race detection for server/task/session/provider. The same four packages' cross-compiled Go test binaries passed under WSL Ubuntu, including the Unix permission and symlink cases skipped on Windows. Edge browser regression passed at 1440x960 and 390x844 using synthetic data. `govulncheck` reported no known Go vulnerabilities. An independent code review's escaped-key reflection and revocation findings were fixed and verified. Public deployment, TLS certificates and live proxy configuration have not been changed or validated in this window.
