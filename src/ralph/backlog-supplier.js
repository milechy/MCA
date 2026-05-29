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
function extractFiledIds(issueTitles = []) {
  const ids = new Set();
  for (const t of issueTitles) {
    const m = String(t || '').match(/^\[([^\]]+)\]/);
    if (m) ids.add(m[1]);
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
//   - first item whose id is unfiled and valid → file it
//   - none left                    → backlog_exhausted
function selectNextItem({ items = [], filedIds = new Set(), openPrs = 0, maxOpenPrs = 3 } = {}) {
  if (openPrs >= maxOpenPrs) {
    return { ok: false, reason: 'too_many_open_prs', open_prs: openPrs, max_open_prs: maxOpenPrs };
  }
  for (const item of items) {
    if (!isValidItem(item)) continue;
    if (filedIds.has(item.id)) continue;
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
  return { ok: false, reason: 'backlog_exhausted' };
}

// Convenience: load + select in one call (workflow uses this via the CLI).
function pickFromBacklog({ backlogPath, issueTitles = [], openPrs = 0, maxOpenPrs = 3 } = {}) {
  const loaded = loadBacklog(backlogPath);
  if (!loaded.ok) return loaded;
  const filedIds = extractFiledIds(issueTitles);
  const sel = selectNextItem({ items: loaded.items, filedIds, openPrs, maxOpenPrs });
  return { ...sel, backlog_version: loaded.version, total_items: loaded.items.length, filed_count: filedIds.size };
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
  isValidItem,
  selectNextItem,
  pickFromBacklog,
  issueTitleFor
};
