// Phase 12 #1: autonomous issue supplier — pure selection logic.
//
// Closes gap ① (continuous trigger). A GitHub Actions schedule reads a
// human-curated backlog and files the next un-filed item as an `aider-fix`
// issue, which the existing Aider Resolver picks up → PR → auto-merge,
// laptop-independent. The HUMAN curates WHAT (the backlog); the cron only
// decides WHEN. We deliberately do NOT auto-invent work (the busywork /
// cost-runaway risk the Grok cross-check warned about).
//
// This module is the pure, testable core: given the backlog and the set of
// already-filed item ids, pick the next item to file (or report why not).
// The workflow does the GitHub I/O around it.

const fs = require('node:fs');

const BACKLOG_VERSION = 'ralph-backlog-v1';

function loadBacklog(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'backlog_not_found', items: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'backlog_parse_error', error: err.message, items: [] };
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return { ok: true, version: parsed.version || null, items };
}

// Issues are filed with title "[<id>] <title>", so we recover the set of
// already-filed ids from existing issue titles (open AND closed — a filed
// item must never be re-filed even after its PR merged and closed it).
// Accepts either plain title strings OR {title, state} objects.
function titleOf(x) { return typeof x === 'string' ? x : (x && x.title) || ''; }
function idFromTitle(t) { const m = String(t || '').match(/^\[([^\]]+)\]/); return m ? m[1] : null; }

function extractFiledIds(issues = []) {
  const ids = new Set();
  for (const x of issues) { const id = idFromTitle(titleOf(x)); if (id) ids.add(id); }
  return ids;
}

// Phase 12 #2: an item's dependency is satisfied once its issue is CLOSED
// (a merged auto PR closes its issue via "Closes #N"). Done ids are derived
// from CLOSED issues only. Requires {title, state} objects; plain strings
// yield an empty set (→ items with deps stay blocked until state is known).
function extractDoneIds(issues = []) {
  const ids = new Set();
  for (const x of issues) {
    const state = (x && x.state ? String(x.state) : '').toUpperCase();
    if (state === 'CLOSED') { const id = idFromTitle(titleOf(x)); if (id) ids.add(id); }
  }
  return ids;
}

function isValidItem(item) {
  return Boolean(
    item
    && typeof item.id === 'string' && item.id.trim()
    && typeof item.title === 'string' && item.title.trim()
    && typeof item.body === 'string' && item.body.trim()
  );
}

// Decide the next item to file.
//   - openPrs >= maxOpenPrs        → skip (don't pile up unreviewed work)
//   - skip already-filed items
//   - skip items whose depends_on are not all DONE (issue closed/merged) —
//     this serializes a dependency-ordered decomposition correctly without
//     relying on the open-PR guard (Phase 12 #2).
//   - first eligible item → file it
//   - none eligible       → backlog_exhausted (all filed) or
//                           blocked_on_deps (remaining are waiting on deps)
function selectNextItem({ items = [], filedIds = new Set(), doneIds = new Set(), openPrs = 0, maxOpenPrs = 3 } = {}) {
  if (openPrs >= maxOpenPrs) {
    return { ok: false, reason: 'too_many_open_prs', open_prs: openPrs, max_open_prs: maxOpenPrs };
  }
  let blockedByDeps = false;
  for (const item of items) {
    if (!isValidItem(item)) continue;
    if (filedIds.has(item.id)) continue;
    const deps = Array.isArray(item.depends_on) ? item.depends_on : [];
    const unmet = deps.filter((d) => !doneIds.has(d));
    if (unmet.length) { blockedByDeps = true; continue; } // try a later, unblocked item
    return {
      ok: true,
      item: {
        id: item.id,
        title: item.title,
        body: item.body,
        labels: Array.isArray(item.labels) && item.labels.length ? item.labels : ['aider-fix']
      }
    };
  }
  return { ok: false, reason: blockedByDeps ? 'blocked_on_deps' : 'backlog_exhausted' };
}

// Convenience: load + select in one call (workflow uses this via the CLI).
// `issues` may be title strings or {title, state} objects (state needed for
// dependency gating).
function pickFromBacklog({ backlogPath, issues = [], openPrs = 0, maxOpenPrs = 3 } = {}) {
  const loaded = loadBacklog(backlogPath);
  if (!loaded.ok) return loaded;
  const filedIds = extractFiledIds(issues);
  const doneIds = extractDoneIds(issues);
  const sel = selectNextItem({ items: loaded.items, filedIds, doneIds, openPrs, maxOpenPrs });
  return { ...sel, backlog_version: loaded.version, total_items: loaded.items.length, filed_count: filedIds.size, done_count: doneIds.size };
}

// The issue title that carries the id back for dedup. Kept here so the
// extractor and the creator agree on the format.
function issueTitleFor(item) {
  return `[${item.id}] ${item.title}`;
}

module.exports = {
  BACKLOG_VERSION,
  loadBacklog,
  extractFiledIds,
  extractDoneIds,
  isValidItem,
  selectNextItem,
  pickFromBacklog,
  issueTitleFor
};
