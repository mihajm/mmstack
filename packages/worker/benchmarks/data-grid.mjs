// Data-grid benchmark for @mmstack/worker.
//
// Workload: filter -> multi-column sort -> group aggregate over N rows, the
// shape a tanstack-table style grid runs on every filter/sort change.
//
// It measures three ways to run that workload and reports, for each row count,
// how long the MAIN THREAD is blocked (the number that decides whether frames
// drop) alongside total wall-clock (the number people wrongly optimise for):
//
//   1. main        - run it inline on the main thread. Blocking == compute.
//   2. worker-ship - a worker computes, but every call ships all N rows in and
//                    the result out. Main thread is free during compute, but
//                    still pays to serialize the rows both ways.
//   3. worker-own  - the worker OWNS the rows (shipped once at load, the
//                    @mmstack/worker model). Each call sends a small param and
//                    gets a small aggregate back. Main-thread cost is flat in N.
//
// The point is not that the worker is faster in wall-clock. It is not: you pay
// serialization on top of compute. The point is the main thread stops doing the
// work, and with worker-own it stops paying to move the data too.
//
// Run: node packages/worker/benchmarks/data-grid.mjs

import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const FRAME_BUDGET_MS = 16; // one 60fps frame

// ---------------------------------------------------------------------------
// The data and the workload (shared by both threads).
// ---------------------------------------------------------------------------

const DEPARTMENTS = [
  'Engineering',
  'Sales',
  'Marketing',
  'Support',
  'Finance',
  'Legal',
  'Ops',
  'Design',
];
const LAST = ['Smith', 'Jones', 'Nguyen', 'Garcia', 'Khan', 'Muller', 'Sato', 'Novak'];

// Deterministic PRNG so every run and both threads see identical data.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function generateRows(n, seed = 42) {
  const rng = makeRng(seed);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: i,
      firstName: `First${i}`,
      lastName: LAST[(rng() * LAST.length) | 0],
      age: 20 + ((rng() * 45) | 0),
      department: DEPARTMENTS[(rng() * DEPARTMENTS.length) | 0],
      salary: 40_000 + ((rng() * 160_000) | 0),
      score: Math.round(rng() * 1000) / 10,
      active: rng() > 0.25,
    };
  }
  return rows;
}

// filter -> multi-column sort -> group aggregate. Returns only the aggregate,
// which is small (one entry per department) regardless of N.
function runWorkload(rows, params) {
  const { minSalary, departments } = params;
  const deptSet = departments ? new Set(departments) : null;

  const filtered = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.active) continue;
    if (r.salary < minSalary) continue;
    if (deptSet && !deptSet.has(r.department)) continue;
    filtered.push(r);
  }

  filtered.sort((a, b) => {
    if (a.department !== b.department)
      return a.department < b.department ? -1 : 1;
    if (a.salary !== b.salary) return b.salary - a.salary;
    return a.lastName < b.lastName ? -1 : a.lastName > b.lastName ? 1 : 0;
  });

  const groups = new Map();
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    let g = groups.get(r.department);
    if (!g) {
      g = {
        department: r.department,
        count: 0,
        totalSalary: 0,
        minAge: Infinity,
        maxAge: -Infinity,
        totalScore: 0,
      };
      groups.set(r.department, g);
    }
    g.count++;
    g.totalSalary += r.salary;
    g.totalScore += r.score;
    if (r.age < g.minAge) g.minAge = r.age;
    if (r.age > g.maxAge) g.maxAge = r.age;
  }

  const out = [];
  for (const g of groups.values()) {
    out.push({
      department: g.department,
      count: g.count,
      avgSalary: Math.round(g.totalSalary / g.count),
      minAge: g.minAge,
      maxAge: g.maxAge,
      avgScore: Math.round((g.totalScore / g.count) * 10) / 10,
    });
  }
  out.sort((a, b) => (a.department < b.department ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Worker side.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  let ownedRows = null; // the rows this worker owns (worker-own mode)

  parentPort.on('message', (msg) => {
    if (msg.type === 'load') {
      // worker-own: receive the rows once, keep them.
      ownedRows = msg.rows;
      parentPort.postMessage({ type: 'loaded', id: msg.id });
      return;
    }
    if (msg.type === 'ship') {
      // worker-ship: rows arrive with every call.
      const result = runWorkload(msg.rows, msg.params);
      parentPort.postMessage({ type: 'result', id: msg.id, result });
      return;
    }
    if (msg.type === 'own') {
      // worker-own: only params arrive; rows already here.
      const result = runWorkload(ownedRows, msg.params);
      parentPort.postMessage({ type: 'result', id: msg.id, result });
      return;
    }
  });
  parentPort.postMessage({ type: 'up' });
}

// ---------------------------------------------------------------------------
// Main side.
// ---------------------------------------------------------------------------

async function main() {
  const SIZES = [1_000, 10_000, 50_000, 100_000, 250_000, 500_000];
  const PARAMS = { minSalary: 80_000, departments: null };
  const ITERS = 7;

  const worker = new Worker(fileURLToPath(import.meta.url));
  await once(worker, (m) => m.type === 'up');

  let nextId = 1;
  // Returns { msg, postMs } where postMs is the synchronous cost of the send.
  // node's worker_threads serializes the payload on the calling thread before
  // postMessage returns, so timing the call captures the real main-thread block
  // for shipping the payload (a browser Worker behaves the same way).
  const call = (payload) =>
    new Promise((resolve) => {
      const id = nextId++;
      const onMsg = (m) => {
        if (m.id !== id) return;
        worker.off('message', onMsg);
        resolve({ msg: m, postMs });
      };
      worker.on('message', onMsg);
      const t0 = performance.now();
      worker.postMessage({ ...payload, id });
      const postMs = performance.now() - t0;
    });

  console.log(
    `\n@mmstack/worker - data-grid benchmark (filter -> multi-sort -> group aggregate)`,
  );
  console.log(
    `frame budget ${FRAME_BUDGET_MS}ms  |  median of ${ITERS} runs  |  ms\n`,
  );
  console.log(
    pad('rows', 9) +
      pad('main', 11) +
      pad('worker-ship', 24) +
      pad('worker-own', 24),
  );
  console.log(
    pad('', 9) +
      pad('block', 11) +
      pad('block', 12) +
      pad('wall', 12) +
      pad('block', 12) +
      pad('wall', 12),
  );
  console.log('-'.repeat(68));

  const table = [];

  for (const n of SIZES) {
    const data = generateRows(n);

    // 1. main thread: blocking == compute.
    const mainBlock = median(
      timeIt(ITERS, () => runWorkload(data, PARAMS)),
    );

    // 2. worker-ship: block == serialize rows out (postMessage) + deserialize
    // the result; wall == the whole round trip.
    await call({ type: 'load', rows: [] }); // reset owned state cheaply
    const shipWall = [];
    const shipBlock = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = performance.now();
      const r = await call({ type: 'ship', rows: data, params: PARAMS });
      // result deserialize on receive; result is small (one row per group).
      const dz0 = performance.now();
      structuredClone(r.msg.result);
      const blockOut = performance.now() - dz0;
      shipWall.push(performance.now() - t0);
      shipBlock.push(r.postMs + blockOut);
    }

    // 3. worker-own: rows shipped once, then only params + aggregate cross.
    await call({ type: 'load', rows: data });
    const ownWall = [];
    const ownBlock = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = performance.now();
      const r = await call({ type: 'own', params: PARAMS });
      const dz0 = performance.now();
      structuredClone(r.msg.result);
      const blockOut = performance.now() - dz0;
      ownWall.push(performance.now() - t0);
      ownBlock.push(r.postMs + blockOut);
    }

    const row = {
      n,
      mainBlock,
      shipBlock: median(shipBlock),
      shipWall: median(shipWall),
      ownBlock: median(ownBlock),
      ownWall: median(ownWall),
    };
    table.push(row);

    console.log(
      pad(fmtN(n), 9) +
        pad(ms(row.mainBlock), 11) +
        pad(ms(row.shipBlock), 12) +
        pad(ms(row.shipWall), 12) +
        pad(ms(row.ownBlock), 12) +
        pad(ms(row.ownWall), 12),
    );
  }

  console.log('-'.repeat(68));
  analyze(table);

  await worker.terminate();
}

function analyze(table) {
  const crossAt = (key) => table.find((r) => r[key] > FRAME_BUDGET_MS);
  const mainCross = crossAt('mainBlock');
  const shipCross = crossAt('shipBlock');
  const ownCross = crossAt('ownBlock');

  console.log('');
  const budgetLine = (label, cross) => {
    if (!cross) {
      console.log(
        `  ${label} stays under the ${FRAME_BUDGET_MS}ms frame budget at every size tested.`,
      );
      return;
    }
    const prev = table[table.indexOf(cross) - 1];
    const lo = prev ? prev.n : 0;
    console.log(
      `  ${label} crosses ${FRAME_BUDGET_MS}ms between ${fmtN(lo)} and ${fmtN(cross.n)} rows.`,
    );
  };
  console.log('When each approach starts dropping frames:');
  budgetLine('inline (main)   ', mainCross);
  budgetLine('worker-ship     ', shipCross);
  budgetLine('worker-own      ', ownCross);

  const big = table[table.length - 1];
  console.log('');
  console.log(`At ${fmtN(big.n)} rows the main thread is blocked for:`);
  console.log(
    `  inline       ${ms(big.mainBlock)}ms  (${(big.mainBlock / FRAME_BUDGET_MS).toFixed(1)} frames) - the compute itself.`,
  );
  console.log(
    `  worker-ship  ${ms(big.shipBlock)}ms  (${(big.shipBlock / FRAME_BUDGET_MS).toFixed(1)} frames) - the tax of shipping every row across, each call.`,
  );
  console.log(
    `  worker-own   ${ms(big.ownBlock)}ms  (${(big.ownBlock / FRAME_BUDGET_MS).toFixed(2)} frames) - flat in row count; the rows never re-cross.`,
  );
  console.log('');
  console.log(
    `Two things fall out. Moving work to a worker is not automatically a win:`,
  );
  console.log(
    `worker-ship blocks the main thread MORE than inline, because serializing`,
  );
  console.log(
    `the whole grid on every call costs more than the compute did. The win only`,
  );
  console.log(
    `shows up when the worker OWNS the data and you send deltas instead of`,
  );
  console.log(
    `snapshots - which is exactly what workerStore does over the op-log. Then`,
  );
  console.log(
    `main-thread blocking stays flat and near zero no matter how big the grid gets.`,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function timeIt(iters, fn) {
  fn(); // warm up / JIT
  const out = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function once(emitter, pred) {
  return new Promise((resolve) => {
    const on = (m) => {
      if (pred(m)) {
        emitter.off('message', on);
        resolve(m);
      }
    };
    emitter.on('message', on);
  });
}

function ms(v) {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
function fmtN(n) {
  return n.toLocaleString('en-US');
}
function pad(s, w) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, w - s.length));
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
