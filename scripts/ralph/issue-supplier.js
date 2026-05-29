#!/usr/bin/env node
// Phase 12 #1 CLI: select the next backlog item to file as an issue.
//
// Pure selection only — does NOT call GitHub. The workflow gathers the
// existing issue titles + open-PR count, calls this to decide, and (if an
// item is returned) creates the issue itself with `gh issue create`.
//
// Usage:
//   node scripts/ralph/issue-supplier.js \
//     --backlog .github/ralph-backlog.json \
//     --titles-file /tmp/titles.json \      # JSON array of existing issue titles (open+closed)
//     --open-prs 1 --max-open-prs 3
//
// Output (stdout): one JSON object.
//   { "ok": true, "item": { "id","title","body","labels" }, "issue_title": "[ID] title" }
//   { "ok": false, "reason": "backlog_exhausted" | "too_many_open_prs" | ... }

const fs = require('node:fs');
const { pickFromBacklog, issueTitleFor } = require('../../src/ralph/backlog-supplier');

function parseArgs(argv) {
  const a = { backlog: '.github/ralph-backlog.json', issuesFile: null, openPrs: 0, maxOpenPrs: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--backlog') a.backlog = argv[++i];
    // --issues-file (preferred: JSON [{title,state}]) or legacy --titles-file (JSON [title])
    else if (k === '--issues-file' || k === '--titles-file') a.issuesFile = argv[++i];
    else if (k === '--open-prs') a.openPrs = parseInt(argv[++i], 10) || 0;
    else if (k === '--max-open-prs') a.maxOpenPrs = parseInt(argv[++i], 10) || 3;
  }
  return a;
}

// Returns the parsed array as-is ({title,state} objects preferred; plain
// strings still accepted — but dependency gating needs state).
function loadIssues(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const issues = loadIssues(args.issuesFile);
  const result = pickFromBacklog({
    backlogPath: args.backlog,
    issues,
    openPrs: args.openPrs,
    maxOpenPrs: args.maxOpenPrs
  });
  if (result.ok && result.item) result.issue_title = issueTitleFor(result.item);
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

if (require.main === module) main();

module.exports = { parseArgs, loadIssues, main };
