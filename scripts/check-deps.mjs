#!/usr/bin/env node
// Checks every publishable package's manifest against the code it actually ships (everything
// reachable from its entry points through relative imports):
// - every bare import resolves to a declared dependency or peer (no missing deps)
// - every declared dependency or required peer is imported somewhere (no obsolete deps)
// - every peerDependenciesMeta key is also a peer, and no optionalDependencies are declared
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(join(root, 'packages'));
const manifests = files.filter((p) => p.endsWith(`${sep}package.json`));
const packageRoots = manifests.map(dirname);

/** Entry files: one per ng-package.json (primary + secondary), else the tsdown `entry` list. */
function entryPoints(pkgRoot, owns) {
  const ngPackages = files.filter(
    (p) => p.endsWith(`${sep}ng-package.json`) && owns(p),
  );
  if (ngPackages.length)
    return ngPackages.map((p) => {
      const lib = JSON.parse(readFileSync(p, 'utf8')).lib ?? {};
      return join(dirname(p), lib.entryFile ?? 'src/public-api.ts');
    });
  const tsdown = join(pkgRoot, 'tsdown.config.ts');
  if (existsSync(tsdown)) {
    const entry = readFileSync(tsdown, 'utf8').match(/entry:\s*\[([^\]]*)\]/);
    if (entry)
      return [...entry[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) =>
        join(pkgRoot, m[1]),
      );
  }
  return [join(pkgRoot, 'src/index.ts')];
}

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const importRe =
  /(?:^|[^.\w$])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  for (const c of [`${base}.ts`, join(base, 'index.ts'), base])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return undefined;
}

const builtins = new Set(builtinModules);
const packageName = (spec) =>
  spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('/')[0];

let failures = 0;
const fail = (pkg, msg) => {
  failures++;
  console.error(`${pkg}: ${msg}`);
};

for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.private) continue;
  const pkgRoot = dirname(manifestPath);
  const name = manifest.name;
  const nested = packageRoots.filter(
    (r) => r !== pkgRoot && r.startsWith(pkgRoot + sep),
  );
  const owns = (p) =>
    p.startsWith(pkgRoot + sep) && !nested.some((n) => p.startsWith(n + sep));

  const used = new Map();
  const seen = new Set();
  const queue = entryPoints(pkgRoot, owns);
  for (const entry of queue)
    if (!existsSync(entry))
      fail(name, `entry point ${relative(root, entry)} does not exist`);

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(
      importRe,
    )) {
      const spec = m[1] ?? m[2];
      if (spec.includes('${')) continue; // generated-code template
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target && owns(target)) queue.push(target);
        continue;
      }
      if (spec.startsWith('node:')) continue;
      const dep = packageName(spec);
      if (builtins.has(dep) || dep === name) continue;
      if (!used.has(dep)) used.set(dep, relative(root, file));
    }
  }

  const deps = Object.keys(manifest.dependencies ?? {});
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const meta = manifest.peerDependenciesMeta ?? {};
  const declared = new Set([...deps, ...peers]);

  for (const [dep, file] of used)
    if (!declared.has(dep))
      fail(name, `imports "${dep}" (${file}) but does not declare it`);
  for (const dep of declared)
    if (!used.has(dep) && !meta[dep]?.optional)
      fail(name, `declares "${dep}" but never imports it`);
  for (const dep of Object.keys(meta))
    if (!peers.includes(dep))
      fail(name, `peerDependenciesMeta lists "${dep}", which is not a peer`);
  if (manifest.optionalDependencies)
    fail(name, 'declares optionalDependencies (use optional peers instead)');
}

if (failures) {
  console.error(`\n${failures} dependency problem(s)`);
  process.exit(1);
}
console.log(`dependencies OK (${manifests.length} packages)`);
