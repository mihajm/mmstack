// @ts-check
// Turns a run's mutation.json into summary.md / summary.json, and rebuilds tmp/stryker/summary.md as an
// index over every run found there.
import fs from 'node:fs';
import path from 'node:path';

const INVALID = new Set(['CompileError', 'RuntimeError']);
const STATUSES = [
  'Killed',
  'Timeout',
  'Survived',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Ignored',
];

/** @param {Record<string, number>} c */
function scores(c) {
  const detected = (c['Killed'] ?? 0) + (c['Timeout'] ?? 0);
  const undetected = (c['Survived'] ?? 0) + (c['NoCoverage'] ?? 0);
  const covered = detected + (c['Survived'] ?? 0);
  const pct = (/** @type {number} */ n, /** @type {number} */ d) =>
    d === 0 ? null : Math.round((n / d) * 10000) / 100;
  return {
    total: pct(detected, detected + undetected),
    covered: pct(detected, covered),
  };
}

/** @param {string} source @param {any} loc */
function original(source, loc) {
  const lines = source.split('\n');
  const { start, end } = loc;
  if (start.line === end.line)
    return lines[start.line - 1].slice(start.column - 1, end.column - 1);
  return [
    lines[start.line - 1].slice(start.column - 1),
    ...lines.slice(start.line, end.line - 1),
    lines[end.line - 1].slice(0, end.column - 1),
  ].join('\n');
}

const oneLine = (/** @type {string} */ s, max = 90) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const code = (/** @type {string} */ s) =>
  `\`${oneLine(s).replace(/`/g, "'")}\``;
const fmt = (/** @type {number | null} */ n) =>
  n === null ? 'n/a' : n.toFixed(2);

/**
 * @param {string} dir absolute run directory (holds mutation.json)
 * @param {{ project: string; tier: string; run: string; head: string; durationMs: number; exitCode: number | null }} meta
 */
export function writeSummary(dir, meta) {
  const report = JSON.parse(
    fs.readFileSync(path.join(dir, 'mutation.json'), 'utf8'),
  );
  /** @type {Record<string, number>} */
  const totals = {};
  const files = [];
  const survivors = [];
  const noCoverage = [];
  /** @type {Record<string, number>} */
  const ignoredReasons = {};

  for (const [file, { source, mutants }] of Object.entries(report.files)) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const m of mutants) {
      counts[m.status] = (counts[m.status] ?? 0) + 1;
      totals[m.status] = (totals[m.status] ?? 0) + 1;
      const at = `${file}:${m.location.start.line}:${m.location.start.column}`;
      const entry = {
        at,
        mutator: m.mutatorName,
        from: original(source, m.location),
        to: m.replacement ?? '',
      };
      if (m.status === 'Survived')
        survivors.push({ ...entry, tests: m.coveredBy?.length ?? 0 });
      if (m.status === 'NoCoverage') noCoverage.push(entry);
      if (m.status === 'Ignored')
        ignoredReasons[m.statusReason ?? 'unknown'] =
          (ignoredReasons[m.statusReason ?? 'unknown'] ?? 0) + 1;
    }
    files.push({
      file,
      counts,
      mutants: mutants.length,
      score: scores(counts),
    });
  }
  files.sort(
    (a, b) =>
      (b.counts['Survived'] ?? 0) +
        (b.counts['NoCoverage'] ?? 0) -
        ((a.counts['Survived'] ?? 0) + (a.counts['NoCoverage'] ?? 0)) ||
      a.file.localeCompare(b.file),
  );

  const score = scores(totals);
  const summary = {
    ...meta,
    date: new Date().toISOString(),
    mutants: Object.values(totals).reduce((a, b) => a + b, 0),
    counts: Object.fromEntries(STATUSES.map((s) => [s, totals[s] ?? 0])),
    score,
    files: files.map(({ file, counts, mutants, score }) => ({
      file,
      mutants,
      counts,
      score,
    })),
  };
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );

  const md = [];
  md.push(`# Mutation report: ${meta.run}`, '');
  md.push(
    `Project \`${meta.project}\`, tier \`${meta.tier}\`, at \`${meta.head}\`, ${summary.date}.`,
  );
  md.push(
    `Duration ${Math.round(meta.durationMs / 1000)} s, Stryker exit code ${meta.exitCode}. HTML report: \`index.html\` next to this file.`,
    '',
  );
  md.push(
    '| Score (all) | Score (covered) | Mutants | ' +
      STATUSES.join(' | ') +
      ' |',
  );
  md.push('|---|---|---|' + STATUSES.map(() => '---').join('|') + '|');
  md.push(
    `| ${fmt(score.total)} | ${fmt(score.covered)} | ${summary.mutants} | ` +
      STATUSES.map((s) => totals[s] ?? 0).join(' | ') +
      ' |',
    '',
  );
  if (Object.keys(ignoredReasons).length) {
    md.push('Ignored by reason:', '');
    for (const [reason, n] of Object.entries(ignoredReasons))
      md.push(`- ${n}: ${reason}`);
    md.push('');
  }
  md.push(
    '## Files',
    '',
    '| File | Mutants | Killed | Timeout | Survived | No cov | Invalid | Score | Covered |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const f of files) {
    const c = f.counts;
    const invalid = [...INVALID].reduce((a, s) => a + (c[s] ?? 0), 0);
    md.push(
      `| \`${f.file}\` | ${f.mutants} | ${c['Killed'] ?? 0} | ${c['Timeout'] ?? 0} | ${c['Survived'] ?? 0} | ${c['NoCoverage'] ?? 0} | ${invalid} | ${fmt(f.score.total)} | ${fmt(f.score.covered)} |`,
    );
  }
  md.push(
    '',
    `## Survived (${survivors.length})`,
    '',
    'Covered by at least one test that still passed with the mutant active.',
    '',
  );
  for (const s of survivors)
    md.push(
      `- \`${s.at}\` ${s.mutator}: ${code(s.from)} → ${code(s.to)} (${s.tests} covering tests)`,
    );
  md.push(
    '',
    `## No coverage (${noCoverage.length})`,
    '',
    'No test reaches the mutated code.',
    '',
  );
  for (const s of noCoverage)
    md.push(`- \`${s.at}\` ${s.mutator}: ${code(s.from)} → ${code(s.to)}`);
  fs.writeFileSync(path.join(dir, 'summary.md'), md.join('\n') + '\n');
  return summary;
}

/** @param {number} ms */
function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** @param {string} outputRoot absolute tmp/stryker */
export function writeIndex(outputRoot) {
  const runs = fs
    .readdirSync(outputRoot, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        fs.existsSync(path.join(outputRoot, d.name, 'summary.json')),
    )
    .map((d) =>
      JSON.parse(
        fs.readFileSync(path.join(outputRoot, d.name, 'summary.json'), 'utf8'),
      ),
    )
    .sort((a, b) => a.run.localeCompare(b.run));
  const md = [
    '# Mutation reports',
    '',
    'One row per run directory below `tmp/stryker/`. Details in `<run>/summary.md`.',
    '',
  ];
  md.push(
    '| Run | Project | Tier | Head | Date | Duration | Mutants | Killed | Timeout | Survived | No cov | Invalid | Score | Covered |',
  );
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const c = r.counts;
    md.push(
      `| [${r.run}](${r.run}/summary.md) | ${r.project} | ${r.tier} | \`${r.head}\` | ${r.date.slice(0, 16).replace('T', ' ')} | ${duration(r.durationMs)} | ${r.mutants} | ${c.Killed} | ${c.Timeout} | ${c.Survived} | ${c.NoCoverage} | ${c.CompileError + c.RuntimeError} | ${fmt(r.score.total)} | ${fmt(r.score.covered)} |`,
    );
  }
  fs.writeFileSync(path.join(outputRoot, 'summary.md'), md.join('\n') + '\n');
}
