#!/usr/bin/env node
import { execute } from './command.ts'

try {
  const report = execute(process.argv.slice(2))
  if (report.command === 'help') process.stdout.write(`${report.usage}\n`)
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ status: 'failed', error: message })}\n`)
  process.exitCode = 1
}
