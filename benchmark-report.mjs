import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const phases = ['comparison', 'backup', 'schema', 'records', 'verification', 'reversal'];
const digest = /^[a-f0-9]{64}$/;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Reports consume real measurements only. Counts alone do not establish correctness.
export function summarizeBenchmark(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('Supply measured benchmark samples.');
  const groups = new Map();
  const identities = new Set();
  const targets = new Set();
  let conditions;
  for (const sample of samples) {
    if (!sample.implementation || !sample.runId || !sample.revision || !sample.runner || !sample.engineVersion
        || !sample.instanceClass || !sample.host || !Number.isInteger(sample.port)
        || !digest.test(sample.fixtureSha256 || '') || !Number.isSafeInteger(sample.tables) || sample.tables < 5
        || !Number.isSafeInteger(sample.changedTables) || sample.changedTables < 3 || sample.changedTables > sample.tables
        || !Number.isSafeInteger(sample.totalRows) || sample.totalRows < 1
        || sample.maintenance !== true || sample.backupVerified !== true
        || !/^fabla_bench_[a-z0-9_]+$/.test(sample.target || '')
        || sample.schemaDifferences !== 0 || sample.recordDifferences !== 0 || sample.reversalDifferences !== 0
        || !digest.test(sample.beforeDigest || '') || sample.restoredDigest !== sample.beforeDigest
        || !digest.test(sample.expectedDigest || '') || sample.afterDigest !== sample.expectedDigest
        || phases.some(phase => !Number.isFinite(sample.timingsMs?.[phase]) || sample.timingsMs[phase] < 0)
        || !Number.isFinite(sample.endToEndMs) || sample.endToEndMs < 0) {
      throw new Error('Incomplete, unsafe or incorrect benchmark sample; no speed winner can be reported.');
    }
    const condition = JSON.stringify([sample.fixtureSha256, sample.host, sample.port, sample.runner,
      sample.instanceClass, sample.engineVersion, sample.tables, sample.changedTables, sample.totalRows,
      sample.beforeDigest, sample.expectedDigest]);
    if (conditions && conditions !== condition) throw new Error('Benchmark conditions or expected contents differ between implementations.');
    conditions = condition;
    const identity = JSON.stringify([sample.implementation, sample.runId]);
    if (identities.has(identity)) throw new Error('Duplicate benchmark sample.');
    if (targets.has(sample.target)) throw new Error('Benchmark runs must use distinct fresh disposable targets.');
    identities.add(identity);
    targets.add(sample.target);
    const list = groups.get(sample.implementation) || [];
    list.push(sample); groups.set(sample.implementation, list);
  }
  if (groups.size !== 2 || [...groups.values()].some(group => group.length < 3)) {
    throw new Error('Use two implementations with at least three fresh-target runs each.');
  }
  if ([...groups.values()].some(group => new Set(group.map(sample => sample.revision)).size !== 1)) {
    throw new Error('Implementation revision changed during the benchmark.');
  }
  return { verified: true, fixtureSha256: samples[0].fixtureSha256,
    implementations: [...groups].map(([implementation, runs]) => ({ implementation, runs: runs.length,
      revision: runs[0].revision, medianEndToEndMs: median(runs.map(run => run.endToEndMs)),
      medianTimingsMs: Object.fromEntries(phases.map(phase => [phase, median(runs.map(run => run.timingsMs[phase]))])),
      samples: runs.map(run => ({ runId: run.runId, target: run.target, endToEndMs: run.endToEndMs, timingsMs: run.timingsMs })),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = process.argv.slice(2);
    if (files.length < 2) throw new Error('Usage: node benchmark-report.mjs OUR_SAMPLES.json OTHER_SAMPLES.json');
    const samples = files.flatMap(file => JSON.parse(readFileSync(file, 'utf8')));
    console.log(JSON.stringify(summarizeBenchmark(samples), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
