#!/usr/bin/env node

const { importGitHubIssuesFromProvider, DEFAULT_READY_LABELS } = require('../../src/ralph/github-issue-provider');

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    repo: env.RALPH_GITHUB_REPO || env.GITHUB_REPOSITORY || null,
    rootDir: process.cwd(),
    readyLabels: DEFAULT_READY_LABELS,
    mode: 'approval',
    target_env: 'local',
    maxIssues: 50,
    perPage: 50
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--repo') options.repo = next();
    else if (arg === '--root') options.rootDir = next();
    else if (arg === '--labels') options.readyLabels = String(next() || '').split(',').map((label) => label.trim()).filter(Boolean);
    else if (arg === '--max-issues') options.maxIssues = Number(next());
    else if (arg === '--per-page') options.perPage = Number(next());
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--target-env') options.target_env = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/ralph/import-github-issues.js --repo owner/name [--labels ralph-ready,autonomous]',
    '',
    'Read-only GitHub issue import. Creates local STORY-GH-* queue records only.',
    'Environment: RALPH_GITHUB_REPO, GITHUB_TOKEN or GH_TOKEN.'
  ].join('\n');
}

function boundedOutput(result) {
  return {
    ok: result.ok,
    stage: result.stage,
    repo: result.repo,
    ready_labels: result.ready_labels,
    fetched_count: result.fetched_count,
    eligible_count: result.eligible_count,
    imported: (result.imported || []).slice(0, 25),
    skipped: (result.skipped || []).slice(0, 50),
    execution_connected: false,
    github_write_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: result.next_action
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  if (options.help) {
    console.log(usage());
    return { ok: true, stage: 'github_issue_import_usage' };
  }
  const result = await importGitHubIssuesFromProvider(options);
  const output = boundedOutput(result);
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      stage: 'github_issue_import_error',
      reason: error.message,
      execution_connected: false,
      github_write_connected: false,
      commands_executed: [],
      repository_files_modified: []
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  usage,
  boundedOutput,
  main
};
