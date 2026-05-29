#!/usr/bin/env node
// Phase 11-D CLI: report planner difficulty-prediction calibration.
//
// Usage:
//   node scripts/ralph/difficulty-calibration.js [--root <dir>] [--min-samples <n>] [--json]
//
// Reads .ralph/outcomes.jsonl (predicted_difficulty vs back-computed
// actual_difficulty), shows a confusion matrix, per-class bias, suggested
// calibration adjustments, and few-shot correction examples for the planner
// prompt. Recommend-only — never silently re-labels anything.

const { buildCalibrationReport, formatCalibrationReport } = require('../../src/ralph/difficulty-calibration');

function parseArgs(argv) {
  const args = { root: process.cwd(), minSamples: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--min-samples') args.minSamples = parseInt(argv[++i], 10) || 3;
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const report = buildCalibrationReport(args.root, { minSamples: args.minSamples });
  stdout.write((args.json ? JSON.stringify(report, null, 2) : formatCalibrationReport(report)) + '\n');
  return report;
}

if (require.main === module) main();

module.exports = { parseArgs, main };
