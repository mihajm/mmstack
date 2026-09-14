// Loads built packages in plain Node, without @angular/compiler. A package passes only if none of
// its module-scope code needs the JIT compiler: no decorated classes of its own, no partially
// compiled peers. Run after `nx run-many -t build`:
//
//   node scripts/check-node-load.mjs @mmstack/primitives/core @mmstack/di @mmstack/mesh
//
// Built packages are made resolvable through dist/node_modules so their own peer imports
// (`@mmstack/primitives` from `@mmstack/mesh`, for example) find the freshly built copies.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const built = join(dist, 'packages');
const shim = join(dist, 'node_modules');

const specifiers = process.argv.slice(2);
if (specifiers.length === 0) {
  console.error('usage: node scripts/check-node-load.mjs <package-specifier>...');
  process.exit(2);
}
if (!existsSync(built)) {
  console.error(`nothing built under ${built}; run the build first`);
  process.exit(2);
}

function* packages(dir, depth = 0) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, 'package.json'))) yield full;
    else if (depth < 1) yield* packages(full, depth + 1);
  }
}

for (const dir of packages(built)) {
  const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!name) continue;
  const link = join(shim, name);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true, recursive: true });
  symlinkSync(dir, link, 'dir');
}

let failed = 0;
for (const specifier of specifiers) {
  const probe = `import(${JSON.stringify(specifier)}).then(
    (m) => console.log('ok   ' + ${JSON.stringify(specifier)} + ' (' + Object.keys(m).length + ' exports)'),
    (e) => { console.log('FAIL ' + ${JSON.stringify(specifier)} + ': ' + String(e.message).split('\\n')[0]); process.exit(1); },
  );`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: dist,
    stdio: 'inherit',
  });
  if (result.status !== 0) failed++;
}
process.exit(failed === 0 ? 0 : 1);
