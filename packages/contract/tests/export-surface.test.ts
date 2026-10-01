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
 * List the module basenames in a directory.
 * @param dir - absolute directory path.
 * @returns basenames without extension.
 */
function readdirNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -3))
}
