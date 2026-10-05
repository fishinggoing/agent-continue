// Development-only bridge: existing acceptance tests exercise the Go executable.
import { spawnSync } from 'node:child_process';
export function execute(args) {
  const binary = process.env.AGENT_CONTINUE_GO_CLI;
  if (!binary) throw new Error('Set AGENT_CONTINUE_GO_CLI to the built Go executable');
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let message = result.stderr.trim();
    try { message = JSON.parse(message).error; } catch { /* preserve the process diagnostic */ }
    throw new Error(message || `Go CLI exited ${result.status}`);
  }
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) return { command: 'help', usage: result.stdout.trim() };
  return JSON.parse(result.stdout);
}
