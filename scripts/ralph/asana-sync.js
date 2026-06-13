#!/usr/bin/env node
// Sync an Asana project's tasks (priority/board order) into ralph-backlog.json
// so the issue-supplier paces them into aider-fix issues → brain-routed PRs.
// Run on a cron by .github/workflows/asana-sync.yml (or manually).
//
// Env:
//   ASANA_TOKEN          Asana Personal Access Token (required)
//   ASANA_PROJECT_GID    project GID to pull from (required)
//   RALPH_BACKLOG_PATH   backlog file (default .github/ralph-backlog.json)
//
// Writes the merged backlog and prints how many items were added/skipped.
const fs = require('node:fs');
const path = require('node:path');
const { fetchAsanaTasks, syncTasksIntoBacklog } = require('../../src/ralph/asana-bridge');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKLOG_PATH = path.join(ROOT, process.env.RALPH_BACKLOG_PATH || '.github/ralph-backlog.json');

function readBacklog() {
  try {
    return JSON.parse(fs.readFileSync(BACKLOG_PATH, 'utf8'));
  } catch {
    return { version: 'ralph-backlog-v1', items: [] };
  }
}

async function main() {
  const token = process.env.ASANA_TOKEN;
  const projectGid = process.env.ASANA_PROJECT_GID;
  if (!token || !projectGid) {
    process.stderr.write('asana-sync: ASANA_TOKEN and ASANA_PROJECT_GID required — skipping\n');
    process.exit(0);
  }

  const fetched = await fetchAsanaTasks({ token, projectGid });
  if (!fetched.ok) {
    process.stderr.write(`asana-sync: fetch failed (${fetched.reason})\n`);
    process.exit(1);
  }

  const before = readBacklog();
  const { backlog, added, skipped } = syncTasksIntoBacklog({ tasks: fetched.tasks, backlog: before });

  if (added > 0) {
    fs.writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2) + '\n', 'utf8');
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    project: projectGid,
    fetched: fetched.tasks.length,
    added,
    skipped_human_approval: skipped.length,
    total_items: backlog.items.length,
    changed: added > 0
  }) + '\n');
}

main().catch((e) => { process.stderr.write('asana-sync error: ' + e.message + '\n'); process.exit(1); });
