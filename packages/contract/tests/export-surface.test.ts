/**
 * The frozen public surface, checked against the document that promises it.
 *
 * `docs/HANDOFF.md` §9.2 declares which names each package exposes and calls the
 * list frozen. That promise was wrong once: both adapters' `index.ts` were
 * written before their `write.ts` existed, so the writers were declared but not
 * actually exported, and nothing caught it.
 *
 * This test reads the document and validates the code against it, so a claim
 * added to prose without a matching export fails here rather than being
 * discovered by a consumer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Repository root, three levels up from this test file. */
const ROOT = join(import.meta.dirname, '..', '..', '..')

/** One package's documented export list. */
interface ClaimedSurface {
  package: string
  names: string[]
}

/**
 * Read the export lists out of `docs/HANDOFF.md` §9.2.
 * @returns one entry per `**`@agent-continue/<pkg>`**` block, with its identifiers.
 */
function claimedSurfaces(): ClaimedSurface[] {
  const handoff = readFileSync(join(ROOT, 'docs', 'HANDOFF.md'), 'utf8')
  const section = handoff.split(/^### 9\.2 /m)[1]?.split(/^#{2,3} /m)[0]
  assert.ok(section !== undefined, 'HANDOFF §9.2 not found; the frozen-surface check cannot run')

  const surfaces: ClaimedSurface[] = []
  const pattern = /\*\*`(@agent-continue\/[a-z-]+)`\*\*[\s\S]*?```([\s\S]*?)```/g
  for (const match of section.matchAll(pattern)) {
    const [, packageName, block] = match as unknown as [string, string, string]
    // The blocks pair a Chinese label with English identifiers; only the latter
    // match this token shape.
    const names = [...new Set(block.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]
    surfaces.push({ package: packageName, names })
  }
  return surfaces
}

test('every name HANDOFF §9.2 declares is actually exported by its package', () => {
  const surfaces = claimedSurfaces()
  assert.ok(surfaces.length >= 3, `expected a block per package, found ${surfaces.length}`)

  const failures: string[] = []
  for (const { package: packageName, names } of surfaces) {
    const folder = packageName.replace('@agent-continue/', '')
    const entry = readFileSync(join(ROOT, 'packages', folder, 'src', 'index.ts'), 'utf8')
    const missing = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(entry))
    if (missing.length > 0) failures.push(`${packageName}: ${missing.join(', ')}`)
  }
  assert.deepEqual(failures, [], 'a documented export is missing from src/index.ts')
})

test('every src module of a package is reachable from its entry point', () => {
  const surfaces = claimedSurfaces()
  const failures: string[] = []
  for (const { package: packageName } of surfaces) {
    const folder = packageName.replace('@agent-continue/', '')
    const dir = join(ROOT, 'packages', folder, 'src')
    const entry = readFileSync(join(dir, 'index.ts'), 'utf8')
    const referenced = new Set([...entry.matchAll(/from '\.\/([a-z0-9-]+)\.ts'/g)].map((match) => match[1]))
    const present = readdirNames(dir)
    for (const module of present) {
      if (module === 'index') continue
      if (!referenced.has(module)) failures.push(`${packageName}: src/${module}.ts is not re-exported`)
    }
  }
  assert.deepEqual(failures, [], 'a source module is unreachable from the package entry point')
})

/**
 * The runtime half of the check.
 *
 * The tests above read text, which a commented-out or type-only export would
 * still satisfy. Codex demonstrated the stronger check during its independent
 * verification of D10: import the entry point and assert the value really is a
 * function. Both halves are kept — the text scan is the only way to cover
 * type-only exports, and this covers everything that must exist at runtime.
 */
test('the runtime entry points are real callable exports', async () => {
  const dsh = await import('../../dsh-adapter/src/index.ts')
  const codex = await import('../../codex-adapter/src/index.ts')
  const contract = await import('../src/index.ts')

  const mustBeFunctions: [string, Record<string, unknown>][] = [
    ['@agent-continue/dsh-adapter', { encodeArtifact: dsh.encodeArtifact, writeArtifact: dsh.writeArtifact }],
    ['@agent-continue/codex-adapter', {
      encodeRollout: codex.encodeRollout,
      writeRollout: codex.writeRollout,
      registerThread: codex.registerThread,
      seedProjectionCursor: codex.seedProjectionCursor,
      extendedLengthPath: codex.extendedLengthPath,
    }],
    ['@agent-continue/contract', {
      convertCodexToDsh: contract.convertCodexToDsh,
      convertDshToCodex: contract.convertDshToCodex,
    }],
  ]

  const failures: string[] = []
  let checked = 0
  for (const [packageName, entries] of mustBeFunctions) {
    for (const [name, value] of Object.entries(entries)) {
      checked += 1
      if (typeof value !== 'function') failures.push(`${packageName}.${name} is ${typeof value}, not a function`)
    }
  }
  assert.deepEqual(failures, [], 'a documented runtime entry point is not callable')
  assert.equal(checked, 9, 'the nine runtime entry points that matter are all covered')

  // The cross-harness markers have to be the literal strings both sides agree on.
  assert.equal(contract.TOOL_OUTCOME_UNKNOWN, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(contract.RECOVERY_FIELD, 'recovery')
})

/**
 * List the module basenames in a directory.
 * @param dir - absolute directory path.
 * @returns basenames without extension.
 */
function readdirNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -3))
}
