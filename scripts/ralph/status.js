#!/usr/bin/env node
// Phase 5 #6: `ralph status` CLI entrypoint. Thin wrapper around
// src/ralph/status-summary.js — buildStatusSummary() does the actual
// aggregation; this file just parses argv and prints.

const { buildStatusSummary, formatStatusSummaryTable, formatStatusSummaryJson } = require('../../src/ralph/status-summary');

function parseArgs(argv) {
  const result = { json: false, root: process.cwd() };
  const args = Array.isArray(argv) ? argv : [];
  // Allow leading 'node script.js' tokens — skip them like submit-idea does.
  const startIndex = (args.length >= 2 && String(args[1] || '').includes('.js')) ? 2 : 0;
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--root') {
      result.root = args[++i] || process.cwd();
    }
    // Unknown flags are silently ignored (per spec).
  }
  return result;
}

async function runStatus({ argv, stdout, stderr, exit, now = new Date() }) {
  const args = parseArgs(argv);
  const summary = buildStatusSummary({ rootDir: args.root, now });
  if (!summary || summary.ok === false) {
    const reason = summary && summary.reason ? summary.reason : 'unknown';
    stderr(JSON.stringify({ ok: false, reason }) + '\n');
    return exit(1);
  }
  const out = args.json ? formatStatusSummaryJson(summary) : formatStatusSummaryTable(summary);
  stdout(out + '\n');
  return exit(0);
}

async function main() {
  await runStatus({
    argv: process.argv.slice(2),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (c) => process.exit(c)
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`status.js: unexpected error: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  });
}

module.exports = { parseArgs, runStatus, main };
