// Asana → ralph-backlog bridge.
//
// Pull tasks from an Asana project (in project/board order = priority) and turn
// the incomplete ones into ralph-backlog items, so the existing issue-supplier
// paces them into aider-fix issues → brain-routed PRs. The CI workflow
// (asana-sync.yml) runs this on a cron + commits the backlog; the bridge itself
// is pure + injectable (fetchImpl) so it's fully unit-testable.
//
// Priority: Asana returns project tasks in the manual board/list order, which
// IS the priority order — top first. We preserve that order.
//
// Safety: tasks whose notes contain HUMAN-APPROVAL-REQUIRED are skipped (not
// auto-filed) so high-risk work stays human-gated, per the operator's intent.

const ASANA_API = 'https://app.asana.com/api/1.0';
const HUMAN_APPROVAL_MARKER = /HUMAN-APPROVAL-REQUIRED/i;

// Stable backlog id from the Asana task gid (so re-syncs dedup correctly even
// if the task is renamed). The issue-supplier dedups on "[<id>]" issue titles.
function backlogIdForTask(task) {
  return `ASANA-${task.gid}`;
}

function isHumanApproval(task) {
  return HUMAN_APPROVAL_MARKER.test(String((task && task.notes) || ''));
}

// Map one Asana task → a ralph-backlog item. Keeps the Asana notes (already a
// spec with DoD + backticked file paths) and appends the source link.
function taskToBacklogItem(task) {
  const title = String((task && task.name) || '').trim().replace(/\s+/g, ' ').slice(0, 120) || 'Untitled Asana task';
  const notes = String((task && task.notes) || '').trim();
  const link = task && task.permalink_url ? `\n\n---\n_synced from Asana: ${task.permalink_url}_` : '';
  return { id: backlogIdForTask(task), title, body: `${notes || title}${link}` };
}

// Fetch all incomplete tasks of a project, in priority (project) order.
// Paginates through next_page. fetchImpl injected for tests.
async function fetchAsanaTasks({ token, projectGid, fetchImpl = fetch, maxPages = 20 } = {}) {
  if (!token || !projectGid) return { ok: false, reason: 'token_and_project_required', tasks: [] };
  const tasks = [];
  let offset = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      opt_fields: 'name,notes,completed,permalink_url',
      limit: '100'
    });
    if (offset) params.set('offset', offset);
    let json;
    try {
      const res = await fetchImpl(`${ASANA_API}/projects/${projectGid}/tasks?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });
      json = await res.json();
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), tasks };
    }
    if (!json || !Array.isArray(json.data)) {
      return { ok: false, reason: 'asana_unexpected_response', errors: json && json.errors, tasks };
    }
    for (const t of json.data) tasks.push(t);
    offset = json.next_page && json.next_page.offset;
    if (!offset) break;
  }
  return { ok: true, tasks };
}

// Merge Asana tasks into an existing backlog: keep current items, append new
// (un-seen id) incomplete + non-approval tasks in priority order. Pure.
function syncTasksIntoBacklog({ tasks = [], backlog = { version: 'ralph-backlog-v1', items: [] } } = {}) {
  const items = Array.isArray(backlog.items) ? [...backlog.items] : [];
  const seen = new Set(items.map((i) => i && i.id));
  const skipped = [];
  let added = 0;
  for (const task of tasks) {
    if (task && task.completed) continue;
    if (isHumanApproval(task)) { skipped.push({ id: backlogIdForTask(task), reason: 'human_approval_required' }); continue; }
    const item = taskToBacklogItem(task);
    if (seen.has(item.id)) continue;
    items.push(item);
    seen.add(item.id);
    added += 1;
  }
  return { backlog: { ...backlog, version: backlog.version || 'ralph-backlog-v1', items }, added, skipped };
}

module.exports = {
  ASANA_API,
  backlogIdForTask,
  isHumanApproval,
  taskToBacklogItem,
  fetchAsanaTasks,
  syncTasksIntoBacklog
};
