// Test only. The old implementation stays unchanged as a comparison oracle.
import { registerHooks } from 'node:module';
const target = new URL('../packages/cli/src/command.ts', import.meta.url).href;
const bridge = new URL('./go-cli-bridge.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url === target ? { url: bridge, shortCircuit: true } : resolved;
} });
