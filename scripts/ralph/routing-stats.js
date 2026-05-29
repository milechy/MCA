#!/usr/bin/env node
// Phase 11-B CLI: print routing statistics from .ralph/outcomes.jsonl.
//
// Usage:
//   node scripts/ralph/routing-stats.js [--root <dir>] [--min-samples <n>] [--json]
//
// Reads the normalized outcome records emitted by task-outcome-recorder.js
// and shows success-rate / cost-per-success per (difficulty × model), per
// context bucket, plus a data-informed recommendation to compare against
// the hand-set DIFFICULTY_TIER_MODELS ladder.

const { buildReport, formatReport } = require('../../src/ralph/routing-stats');

function parseArgs(argv) {
  const args = { root: process.cwd(), minSamples: 2, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--min-samples') args.minSamples = parseInt(argv[++i], 10) || 2;
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const report = buildReport(args.root, { minSamples: args.minSamples });
  if (args.json) {
    stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    stdout.write(formatReport(report) + '\n');
  }
  return report;
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, main };
