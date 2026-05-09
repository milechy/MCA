const { importGitHubIssuesAsStories, normalizeIssue } = require('./github-issue-queue');
const { sortStoriesByPriority } = require('./story-priority');

const DEFAULT_READY_LABELS = Object.freeze(['ralph-ready', 'autonomous']);
const DEFAULT_MAX_ISSUES = 50;
const DEFAULT_PER_PAGE = 50;

function oneLine(value, maxLength = 1000) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactText(value, maxLength = 3000) {
  return oneLine(value, maxLength)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s`'\"]+/gi, '$1=[REDACTED]');
}

function normalizeLabelList(labels = []) {
  if (!Array.isArray(labels)) return [];
  return Array.from(new Set(labels.map((label) => {
    if (typeof label === 'string') return oneLine(label, 80);
    if (label && typeof label === 'object') return oneLine(label.name || label.label || '', 80);
    return '';
  }).filter(Boolean)));
}

function validateRepo(repo) {
  const value = String(repo || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('github_repo_must_be_owner_slash_name');
  }
  return value;
}

function normalizeGitHubApiIssue(raw = {}) {
  const normalized = normalizeIssue(raw);
  return {
    ...normalized,
    issue_number: normalized.issue_number,
    title: redactText(normalized.title, 240),
    body: redactText(normalized.body, 3000),
    labels: normalizeLabelList(normalized.labels),
    url: normalized.url,
    state: raw.state || 'open',
    created_at: raw.created_at || null,
    updated_at: raw.updated_at || null
  };
}

function issueSummary(issue) {
  return {
    issue_number: issue.issue_number,
    title: redactText(issue.title, 160),
    labels: normalizeLabelList(issue.labels).slice(0, 25),
    url: issue.url || null,
    updated_at: issue.updated_at || null
  };
}

function labelMatches(issue, readyLabels = DEFAULT_READY_LABELS) {
  const required = normalizeLabelList(readyLabels).map((label) => label.toLowerCase());
  if (required.length === 0) return true;
  const labels = normalizeLabelList(issue.labels).map((label) => label.toLowerCase());
  return required.some((label) => labels.includes(label));
}

function filterEligibleIssues(issues = [], { readyLabels = DEFAULT_READY_LABELS } = {}) {
  const seen = new Set();
  const eligible = [];
  const skipped = [];
  for (const raw of issues) {
    const issue = normalizeGitHubApiIssue(raw);
    const key = String(issue.issue_number || '').trim();
    if (!key) {
      skipped.push({ reason: 'issue_number_missing' });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ issue_number: issue.issue_number, reason: 'duplicate_issue_in_fetch' });
      continue;
    }
    seen.add(key);
    if (!labelMatches(issue, readyLabels)) {
      skipped.push({ issue_number: issue.issue_number, reason: 'label_filter_not_matched', labels: issue.labels });
      continue;
    }
    eligible.push(issue);
  }
  return { eligible, skipped };
}

async function fetchOpenIssues({
  repo,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = 'https://api.github.com',
  perPage = DEFAULT_PER_PAGE,
  maxIssues = DEFAULT_MAX_ISSUES
} = {}) {
  const repository = validateRepo(repo || process.env.RALPH_GITHUB_REPO);
  if (typeof fetchImpl !== 'function') throw new Error('fetch_impl_required');
  const boundedPerPage = Math.max(1, Math.min(100, Number(perPage) || DEFAULT_PER_PAGE));
  const boundedMaxIssues = Math.max(1, Math.min(100, Number(maxIssues) || DEFAULT_MAX_ISSUES));
  const url = `${String(apiBaseUrl).replace(/\/$/, '')}/repos/${repository}/issues?state=open&per_page=${boundedPerPage}&sort=updated&direction=desc`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ralph-github-issue-provider'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(url, { method: 'GET', headers });
  if (!response || !response.ok) {
    const status = response && response.status ? response.status : 'unknown';
    throw new Error(`github_issue_fetch_failed_${status}`);
  }
  const payload = await response.json();
  const issues = (Array.isArray(payload) ? payload : [])
    .filter((issue) => !issue.pull_request)
    .slice(0, boundedMaxIssues)
    .map(normalizeGitHubApiIssue);
  return {
    ok: true,
    stage: 'github_issue_provider_fetch',
    repo: repository,
    fetched: issues.length,
    issues,
    issue_summaries: issues.map(issueSummary),
    execution_connected: false,
    github_write_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: issues.length > 0 ? 'import_eligible_github_issues' : 'wait_for_new_issues'
  };
}

async function importGitHubIssuesFromProvider({
  provider = { fetchOpenIssues },
  repo = process.env.RALPH_GITHUB_REPO,
  readyLabels = DEFAULT_READY_LABELS,
  rootDir = process.cwd(),
  now = new Date(),
  mode = 'approval',
  target_env = 'local',
  perPage,
  maxIssues,
  token,
  fetchImpl,
  apiBaseUrl
} = {}) {
  const fetcher = typeof provider === 'function' ? provider : provider.fetchOpenIssues;
  if (typeof fetcher !== 'function') throw new Error('github_issue_provider_fetch_open_issues_required');
  const fetched = await fetcher({ repo, token, fetchImpl, apiBaseUrl, perPage, maxIssues });
  const issues = Array.isArray(fetched) ? fetched : fetched.issues;
  const filtered = filterEligibleIssues(issues || [], { readyLabels });
  const imported = importGitHubIssuesAsStories(filtered.eligible, { rootDir, now, mode, target_env });
  return {
    ok: true,
    stage: 'github_issue_provider_import',
    repo: repo || fetched.repo || null,
    ready_labels: normalizeLabelList(readyLabels),
    fetched_count: issues ? issues.length : 0,
    eligible_count: filtered.eligible.length,
    imported: sortStoriesByPriority(imported.imported || []),
    skipped: [...filtered.skipped, ...(imported.skipped || [])].slice(0, 100),
    issue_summaries: filtered.eligible.map(issueSummary),
    execution_connected: false,
    github_write_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: imported.imported && imported.imported.length > 0 ? 'run_autonomous_scheduler_tick' : 'wait_for_new_issues'
  };
}

module.exports = {
  DEFAULT_READY_LABELS,
  normalizeLabelList,
  validateRepo,
  normalizeGitHubApiIssue,
  issueSummary,
  labelMatches,
  filterEligibleIssues,
  fetchOpenIssues,
  importGitHubIssuesFromProvider,
  redactText
};
