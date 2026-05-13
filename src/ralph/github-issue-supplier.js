const { importGitHubIssuesFromProvider, DEFAULT_READY_LABELS } = require('./github-issue-provider');

const SUPPLIER_VERSION = 'github_issue_supplier_v0_1';
const DEFAULT_PULL_EVERY_CYCLES = 0;
const MAX_PULL_EVERY_CYCLES = 1440;

function normalizeReadyLabels(value) {
  if (Array.isArray(value)) return value.map((label) => String(label || '').trim()).filter(Boolean);
  return String(value || '').split(',').map((label) => label.trim()).filter(Boolean);
}

function shouldPullIssuesThisCycle(cycle, every_cycles) {
  const interval = Number.isInteger(every_cycles) ? every_cycles : Number.parseInt(every_cycles, 10);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  if (!Number.isInteger(cycle) || cycle <= 0) return false;
  const bounded = Math.min(Math.max(1, interval), MAX_PULL_EVERY_CYCLES);
  return ((cycle - 1) % bounded) === 0;
}

function supplierOptionsFromEnv(env = process.env) {
  const repo = env.RALPH_GITHUB_REPO || env.GITHUB_REPOSITORY || null;
  const readyLabels = env.RALPH_GITHUB_READY_LABELS
    ? normalizeReadyLabels(env.RALPH_GITHUB_READY_LABELS)
    : Array.from(DEFAULT_READY_LABELS);
  const pullEvery = Number.parseInt(env.RALPH_ISSUE_PULL_EVERY_CYCLES || `${DEFAULT_PULL_EVERY_CYCLES}`, 10);
  const maxIssues = Number.parseInt(env.RALPH_ISSUE_PULL_MAX || '50', 10);
  return {
    repo,
    ready_labels: readyLabels,
    pull_every_cycles: Number.isFinite(pullEvery) ? Math.min(Math.max(0, pullEvery), MAX_PULL_EVERY_CYCLES) : DEFAULT_PULL_EVERY_CYCLES,
    max_issues: Number.isFinite(maxIssues) && maxIssues > 0 ? Math.min(maxIssues, 100) : 50
  };
}

function boundedSupplierResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    stage: result.stage || null,
    repo: result.repo || null,
    fetched_count: Number.isFinite(result.fetched_count) ? result.fetched_count : 0,
    eligible_count: Number.isFinite(result.eligible_count) ? result.eligible_count : 0,
    imported_count: Array.isArray(result.imported) ? result.imported.length : 0,
    imported_story_ids: Array.isArray(result.imported) ? result.imported.map((story) => story.story_id).slice(0, 25) : [],
    skipped_count: Array.isArray(result.skipped) ? result.skipped.length : 0,
    skipped_preview: Array.isArray(result.skipped) ? result.skipped.slice(0, 10).map((entry) => ({ story_id: entry.story_id || null, issue_number: entry.issue_number || null, reason: entry.reason || null })) : [],
    next_action: result.next_action || null
  };
}

async function tickIssueSupplier({
  cycle = 1,
  options = {},
  env = process.env,
  rootDir = process.cwd(),
  now = new Date(),
  importFn = importGitHubIssuesFromProvider
} = {}) {
  const resolved = { ...supplierOptionsFromEnv(env), ...options };
  if (!shouldPullIssuesThisCycle(cycle, resolved.pull_every_cycles)) {
    return {
      ok: true,
      stage: 'github_issue_supplier_skip',
      version: SUPPLIER_VERSION,
      reason: 'pull_not_due_this_cycle',
      pulled: false,
      cycle,
      pull_every_cycles: resolved.pull_every_cycles,
      summary: null
    };
  }
  if (!resolved.repo) {
    return {
      ok: false,
      stage: 'github_issue_supplier_skip',
      version: SUPPLIER_VERSION,
      reason: 'github_repo_not_configured',
      pulled: false,
      cycle,
      pull_every_cycles: resolved.pull_every_cycles,
      summary: null,
      next_action: 'set_RALPH_GITHUB_REPO_or_GITHUB_REPOSITORY'
    };
  }
  try {
    const result = await importFn({
      repo: resolved.repo,
      readyLabels: resolved.ready_labels,
      rootDir,
      now,
      mode: 'approval',
      target_env: 'local',
      maxIssues: resolved.max_issues
    });
    return {
      ok: result.ok === true,
      stage: 'github_issue_supplier_pull',
      version: SUPPLIER_VERSION,
      reason: null,
      pulled: true,
      cycle,
      pull_every_cycles: resolved.pull_every_cycles,
      repo: resolved.repo,
      ready_labels: resolved.ready_labels,
      summary: boundedSupplierResult(result),
      next_action: result.next_action || null
    };
  } catch (error) {
    return {
      ok: false,
      stage: 'github_issue_supplier_error',
      version: SUPPLIER_VERSION,
      reason: String(error && error.message ? error.message : 'github_issue_supplier_error').slice(0, 240),
      pulled: true,
      cycle,
      pull_every_cycles: resolved.pull_every_cycles,
      repo: resolved.repo,
      summary: null,
      next_action: 'inspect_github_issue_supplier_failure'
    };
  }
}

module.exports = {
  SUPPLIER_VERSION,
  DEFAULT_PULL_EVERY_CYCLES,
  MAX_PULL_EVERY_CYCLES,
  shouldPullIssuesThisCycle,
  supplierOptionsFromEnv,
  boundedSupplierResult,
  tickIssueSupplier
};
