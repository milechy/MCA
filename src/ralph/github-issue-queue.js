const { createStory, listStories } = require('./story-queue');
const { sortStoriesByPriority } = require('./story-priority');

function normalizeIssue(issue = {}) {
  const number = issue.number || issue.issue_number || issue.id;
  const title = String(issue.title || '').trim();
  const body = String(issue.body || issue.description || '').trim();
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => typeof label === 'string' ? label : label.name).filter(Boolean) : [];
  return {
    issue_number: number,
    title,
    body,
    labels,
    url: issue.html_url || issue.url || null
  };
}

function storyIdForIssue(issue) {
  const number = String(issue.issue_number || issue.number || issue.id || '').replace(/[^0-9A-Z_-]/gi, '').toUpperCase();
  return `STORY-GH-${number || 'UNKNOWN'}`;
}

function issueRequirement(issue) {
  const parts = [`GitHub Issue #${issue.issue_number}: ${issue.title}`];
  if (issue.body) parts.push(issue.body.slice(0, 3000));
  if (issue.url) parts.push(`Issue URL: ${issue.url}`);
  return parts.join('\n\n');
}

function importGitHubIssuesAsStories(issues = [], { rootDir = process.cwd(), now = new Date(), mode = 'approval', target_env = 'local' } = {}) {
  const existing = new Set(listStories({ rootDir, limit: 100 }).map((story) => story.story_id));
  const imported = [];
  const skipped = [];
  for (const raw of issues) {
    const issue = normalizeIssue(raw);
    const story_id = storyIdForIssue(issue);
    if (existing.has(story_id)) {
      skipped.push({ story_id, reason: 'story_already_exists', issue_number: issue.issue_number });
      continue;
    }
    const created = createStory({
      story_id,
      title: issue.title || `GitHub Issue #${issue.issue_number}`,
      requirement: issueRequirement(issue),
      labels: issue.labels,
      github_issue: issue,
      mode,
      target_env
    }, { rootDir, now });
    if (created.ok) imported.push(created.summary);
    else skipped.push({ story_id, reason: created.reason, issue_number: issue.issue_number });
  }
  return {
    ok: true,
    stage: 'github_issue_queue_import',
    imported: sortStoriesByPriority(imported),
    skipped,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: imported.length > 0 ? 'run_autonomous_scheduler_tick' : 'wait_for_new_issues'
  };
}

module.exports = {
  normalizeIssue,
  storyIdForIssue,
  issueRequirement,
  importGitHubIssuesAsStories
};
