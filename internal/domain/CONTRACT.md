# Go Runtime Contracts

Schema version: 1. These contracts define the Go task runtime and CLI interfaces.
`types.go` is the authoritative structured schema. Migration reports remain
owned by `app` / `migrate`; native registries are never the Agent database.

## Module Boundaries

`domain` imports only the Go standard library. Configuration imports domain;
provider imports configuration and domain. Future tools, permission, session,
agent and task packages depend on these contracts, not CLI or HTTP handlers.
All external model, tool, permission, storage and task operations receive a
cancellable context. Provider output is a proposal, not execution authority.
CLI and HTTP will use one TaskService and one persistent Event format.

Messages carry content parts, role, source and original IDs; tool proposals
and feedback have stable call IDs. Usage uses nullable counters. Approvals
bind session/run/call, canonical parameter hash, scope and expiry. Import
provenance/loss records cannot grant permission or become system messages.

## CLI And Event Grammar (A03)

Implemented commands:

- Existing `help`, `inspect`, `migrate`, `install`, `serve`: existing parser,
  report and failure code 1. `install --from` still denotes artifact owner.
- `config init [--config FILE] [--cwd DIR]`: exclusive initialization; default
  cwd is recorded explicitly in the generated file; default policy is readonly.
- `config show|check [--config FILE] [--model MODEL] [--endpoint URL]
  [--data-dir DIR]`: show references only; check local config, model credential
  presence and workspace readability, with no network calls.
- `models list [--config FILE] [--model MODEL]`: local documented model list,
  with configured model marked. No model credential needed and no discovery.
- `doctor [--config FILE]`: checks plus a disposable state-directory write probe.
- `version`: JSON with version, revision, dirty flag and actual Go/OS/architecture.

New commands use named `--option VALUE` arguments. Reject duplicate/unknown
options, missing values, positional extras and `--option=value`.
Configuration and session commands output one JSON value on stdout; text help
and human-readable model commands are exceptions. Failures use
the existing JSON error on stderr and code 1; failed readiness may also print
its structured check report on stdout. Overrides are resolved once per load:
flags > AGENT_CONTINUE_* > file > defaults. Environment names are
`AGENT_CONTINUE_CONFIG`, `AGENT_CONTINUE_ENDPOINT`, `AGENT_CONTINUE_MODEL`,
`AGENT_CONTINUE_DATA_DIR`. Existing runs will retain their initial snapshot.

Implemented model and local session commands:

- `run --cwd DIR --prompt TEXT [--config FILE] [--model MODEL] [--json]`;
  prompt from stdin when `--prompt` is omitted; explicit workspace required.
- `chat [--cwd DIR] [--config FILE] [--model MODEL]`.
- `resume ID [--prompt TEXT] [--config FILE] [--model MODEL] [--json]`;
  without a prompt, interactive terminals enter chat; otherwise read stdin.
- `sessions list [--config FILE]` and `sessions show|export ID [--config FILE]`;
  output local snapshots as JSON. Import grammar remains deferred.

Local commands use the validated config and referenced environment credential,
not browser model settings. `run --cwd` is required; `chat` defaults to current
directory. The workspace must exist under configured workspaceRoots; every
resume rechecks it. Local sessions use dataDir/cli-v1 with a persistent CLI
database marker. The web service rejects that mode, and its UserService does
not expose local histories. Session queries do not require a model credential.

Local tools support list_files/read_file/apply_patch/create_file, no shell.
readonly denies writes, ask requires a current approval, and local allow grants
only explicitly listed write tool names. Noninteractive and JSON execution
immediately deny pending approvals. Chat accepts /new, /exit and /quit.
Local file access is bounded, excludes protected paths and links, and rejects
known model credentials. Arbitrary embedded third-party secrets cannot be
identified by filename checks; keep them outside allowed workspace roots.

Noninteractive execution never waits on invisible approvals. Event JSON will
be newline-delimited Event records on stdout with schema version, strictly
increasing per-session sequence, UTC timestamp, session/run IDs, event type and
typed payload. Deltas are not completed messages. The terminal event includes
the persisted Run and accurate execution counts. Events can be replayed after
a supplied sequence; CLI and Web do not fabricate progress or tool results.

Run/tool statuses and event names are defined in `types.go`. Model exit codes:
0 for completed; 1 for failure, interrupted or quota; 2 for cancellation;
3 for a configured limit. Reasons distinguish stop, tool_failure, error,
cancelled, limit, quota and interrupted. Ctrl+C cancels before final reporting.
Human terminal output removes control and format characters. JSON preserves
data with JSON escaping. Cancelled runs are persisted before normal CLI exit.

## Storage And Isolation Decision (A05)

Session storage uses a separate `sessions-v1.sqlite` beneath
the explicit data directory, using the existing pure Go SQLite dependency.
Versioned metadata and append-only typed events share transactions and an
authoritative log. Corruption / unsupported schemas are rejected; rebuilding
an index must not erase history. Commit a tool intent before execution;
commit results afterward. A crash in that gap yields unknown/interrupted and
requires verification, never an automatic replay of writes or commands.

Session and canonical workspace leases will use OS file locks held for the
run: Linux flock and Windows LockFileEx. Acquire in deterministic order;
reject contention. OS locks are released on process exit without guessing a
stale PID. Transactional events alone cannot isolate filesystem side effects.
Database locks, exact-root workspace process leases and crash recovery are
implemented. Workspace leases live in the OS user's cache directory; active
ancestor overlaps are checked within a service, not across different configs.
Process sandboxing remains a separate requirement for future shell execution;
the current tools do not execute arbitrary processes.

| Capability | Windows | Linux | Enforcement / Current status |
| --- | --- | --- | --- |
| File-tool root, link, size and credential exclusions | required | required | os.Root and application checks; local and upload policies differ |
| Approval/hash/expiry binding | required | required | application policy implemented |
| Command environment and output budgets | allowlist | allowlist | config helper implemented; execution C06 pending |
| Process-tree cancellation | Job Object with kill-on-close | process group termination | OS mechanism; C07 pending |
| Filesystem/network process sandbox | not supplied by cwd or Job | not supplied by cwd or process group | requires separate OS/container isolation |
| Service command execution | controlled service identity plus isolation | controlled service identity plus isolation | no Agent command execution implemented yet |

Only isolation mode `none` is currently accepted; unavailable modes are rejected.
This setting does not imply safe process execution. Before enabling service
commands, C07/G04 must enforce and verify independent identity, filesystem and
process restrictions. Default tool policy is readonly. Permission is checked
after parameter validation and before intent persistence/execution, separately
for every complete call. An imported approval is never a current-run grant.

Future tools will list/read/search, apply conflict-checked atomic single-file
changes, report task-relative diffs, and execute argv with separate stdout,
stderr, exit code and bounded output. Writes preserve pre-task changes; deletion
requires explicit authority. Search, task-relative diffs and process execution
remain planned; current file tools and the configuration command environment
helper do not provide them.
