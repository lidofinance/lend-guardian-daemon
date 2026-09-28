// Public contracts expose only the standard RPC schema from viem; concrete clients belong to /clients.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ENTRY_POINTS = ['dist/src/core/index.d.ts'];
const RPC_DECLARATION = resolve('dist/src/chain/rpc.d.ts');
const RPC_SCHEMA_IMPORT = /^import type \{ EIP1193Parameters, PublicRpcSchema \} from ['"]viem['"];$/m;
const FORBIDDEN = /(?:from\s+|import\(\s*)(['"])viem(?:\/[^'"]*)?\1/;

/**
 * A relative specifier in either quote style, after `from` or inside an inline `import("...")` type.
 * TypeScript writes the inline form, in double quotes, when a declaration needs a type its source
 * never imported, such as the inferred type of an exported constant.
 */
const RELATIVE_SPECIFIER = /(?:from\s+|import\(\s*)(['"])(\.[^'"]*)\1/g;

/** A declaration keeps the specifier the source wrote, so `./x.ts` and `./x.js` both mean `x.d.ts`. */
function declarationOf(target: string): string {
  if (target.endsWith('.d.ts')) {
    return target;
  }
  return `${target.replace(/\.(ts|js)$/, '')}.d.ts`;
}

async function closure(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || seen.has(path)) {
      continue;
    }
    const contents = await readFile(path, 'utf8');
    seen.set(path, contents);
    for (const [, , specifier] of contents.matchAll(RELATIVE_SPECIFIER)) {
      queue.push(declarationOf(resolve(dirname(path), specifier ?? '')));
    }
  }
  return seen;
}

const reachable = new Map<string, string>();
for (const entry of ENTRY_POINTS) {
  for (const [path, contents] of await closure(entry)) {
    reachable.set(path, contents);
  }
}

const leaks = [...reachable].filter(([path, contents]) => {
  const checked = path === RPC_DECLARATION ? contents.replace(RPC_SCHEMA_IMPORT, '') : contents;
  return FORBIDDEN.test(checked);
});
if (leaks.length > 0) {
  console.error('Unexpected viem types reach the public surface through:');
  for (const [path] of leaks) {
    console.error(`  ${path}`);
  }
  process.exitCode = 1;
} else {
  console.log(`${reachable.size} reachable declaration files; only standard RPC schema imports allowed`);
}

// Resolve the actual package subpath after the clean build, not a source-only export.
const clients = await import('guardian-daemon-sdk/clients');
if (Object.keys(clients).sort().join(',') !== 'ViemRpcClient,createViemRpcTransport') {
  throw new Error('The /clients entry point must expose the viem client and transport');
}
console.log('/clients resolves the built viem client and transport');
