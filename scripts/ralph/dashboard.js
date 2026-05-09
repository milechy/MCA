#!/usr/bin/env node

const { generateDashboard, dashboardToMarkdown } = require('../../src/ralph/dashboard');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    rootDir: process.cwd(),
    format: 'json',
    story_limit: 100,
    recent_limit: 25
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--root') options.rootDir = next();
    else if (arg === '--format') options.format = next();
    else if (arg === '--story-limit') options.story_limit = Number(next());
    else if (arg === '--recent-limit') options.recent_limit = Number(next());
    else if (arg === '--markdown') options.format = 'markdown';
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/ralph/dashboard.js [--root PATH] [--json|--markdown]',
    '',
    'Read-only local Ralph dashboard/status report.',
    'Does not execute commands, mutate repository files, or contact external services.'
  ].join('\n');
}

function renderDashboard(dashboard, format = 'json') {
  if (format === 'markdown' || format === 'md') return dashboardToMarkdown(dashboard);
  return JSON.stringify(dashboard, null, 2);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, stage: 'ralph_dashboard_usage' };
  }
  const dashboard = generateDashboard(options);
  console.log(renderDashboard(dashboard, options.format));
  return dashboard;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      stage: 'ralph_dashboard_error',
      reason: error.message,
      execution_connected: false,
      commands_executed: [],
      repository_files_modified: []
    }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  usage,
  renderDashboard,
  main
};
