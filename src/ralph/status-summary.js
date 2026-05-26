const fs = require('node:fs');
const path = require('node:path');

// Phase 5 #6: pure aggregator for "ralph status". Every external dependency
// (listStories / loadMode / readDailySpend / dailyBudgetCap) is injectable
// with a sensible default so the function is unit-testable without touching
// the filesystem or the kimi-cost-tracker singleton.

function defaultListStories(rootDir) {
  const dir = path.join(rootDir, '.ralph', 'stories');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch (_err) { /* skip malformed */ }
  }
  return out;
}

// Ordering buckets: running/waiting first (where the operator's attention is
// needed RIGHT NOW), then queued (the upcoming work), then completed (recent
// history), finally failed (post-mortem).
const STATUS_ORDER = Object.freeze({
  running: 0,
  waiting_approval: 0,
  queued: 1,
  completed: 2,
  failed: 3,
  stopped: 4
});

function statusBucket(status) {
  const order = STATUS_ORDER[status];
  return typeof order === 'number' ? order : 99;
}

function pickUpdatedAt(story) {
  return Date.parse(story.updated_at || story.created_at || '') || 0;
}

function compareStories(a, b) {
  const bucketDelta = statusBucket(a.status) - statusBucket(b.status);
  if (bucketDelta !== 0) return bucketDelta;
  // Within a bucket: most recently updated first.
  return pickUpdatedAt(b) - pickUpdatedAt(a);
}

function emptyCounts() {
  return { queued: 0, running: 0, waiting_approval: 0, completed: 0, failed: 0, stopped: 0, total: 0 };
}

function buildModeSnapshot(loadMode, rootDir, now) {
  if (!loadMode) loadMode = () => require('./mode-manager').loadMode(rootDir);
  let mode;
  try {
    mode = loadMode(rootDir);
  } catch (_err) {
    return { mode: null, error: 'mode_unavailable' };
  }
  if (!mode) return { mode: null, error: 'mode_unavailable' };
  const expiresAtMs = mode.effective_until ? Date.parse(mode.effective_until) : null;
  const expired = mode.mode === 'fullauto' && expiresAtMs != null && expiresAtMs <= now.getTime();
  const expires_in_ms = expiresAtMs != null ? expiresAtMs - now.getTime() : null;
  return {
    mode: mode.mode || null,
    effective_until: mode.effective_until || null,
    expires_in_ms,
    expired
  };
}

function buildCostSnapshot(readDailySpend, dailyBudgetCap, rootDir, now) {
  const readSpend = readDailySpend || ((opts) => require('./kimi-cost-tracker').readDailySpend(opts));
  const readCap = dailyBudgetCap || ((opts) => require('./kimi-cost-tracker').dailyBudgetCap(opts));
  let spend;
  try {
    spend = readSpend({ rootDir, date: now });
  } catch (_err) {
    return { error: 'cost_unavailable' };
  }
  if (!spend) return { error: 'cost_unavailable' };
  let cap;
  try { cap = readCap(); } catch (_err) { cap = 5; }
  if (!Number.isFinite(cap) || cap <= 0) cap = 5;
  const daily_spend = Number.isFinite(spend.cost_usd) ? spend.cost_usd : 0;
  const fraction = cap > 0 ? daily_spend / cap : 0;
  return {
    daily_spend,
    daily_cap: cap,
    fraction,
    paused_at_cap: daily_spend >= cap
  };
}

function summarizeStory(story) {
  const lastReview = story.last_review_result || null;
  return {
    story_id: story.story_id || story.id || null,
    title: story.title || null,
    status: story.status || null,
    current_phase: story.current_phase || null,
    executor_model: story.executor_model || null,
    attempts: Number.isInteger(story.attempts) ? story.attempts : 0,
    max_attempts: Number.isInteger(story.max_attempts) ? story.max_attempts : null,
    pr_number: story.pr_number || null,
    pr_url: story.pr_url || null,
    updated_at: story.updated_at || null,
    last_verdict: lastReview && typeof lastReview.verdict === 'string' ? lastReview.verdict : null,
    last_repair_instruction_present: typeof story.last_repair_instruction === 'string' && story.last_repair_instruction.trim().length > 0
  };
}

function buildStatusSummary({ rootDir, now, listStories, loadMode, readDailySpend, dailyBudgetCap } = {}) {
  const nowDate = now instanceof Date ? now : new Date();
  if (!rootDir) {
    return { ok: false, reason: 'rootdir_required', checked_at: nowDate.toISOString() };
  }
  const listFn = listStories || defaultListStories;
  let stories;
  try {
    stories = listFn(rootDir);
  } catch (_err) {
    return { ok: false, reason: 'list_stories_failed', checked_at: nowDate.toISOString() };
  }

  const counts = emptyCounts();
  for (const story of stories) {
    const status = story.status;
    if (counts[status] !== undefined) counts[status] += 1;
    counts.total += 1;
  }

  const sorted = stories.slice().sort(compareStories);
  const summarizedStories = sorted.slice(0, 25).map(summarizeStory);

  const mode = buildModeSnapshot(loadMode, rootDir, nowDate);
  const cost = buildCostSnapshot(readDailySpend, dailyBudgetCap, rootDir, nowDate);

  return {
    ok: true,
    checked_at: nowDate.toISOString(),
    counts,
    stories: summarizedStories,
    mode,
    cost
  };
}

function formatModeLine(modeSnap) {
  if (!modeSnap || modeSnap.error) return 'unavailable';
  if (!modeSnap.mode) return 'unavailable';
  if (modeSnap.mode === 'fullauto') {
    if (modeSnap.expired) {
      return `fullauto EXPIRED at ${modeSnap.effective_until || '(unknown)'}`;
    }
    if (modeSnap.expires_in_ms != null && modeSnap.expires_in_ms > 0) {
      const totalMin = Math.floor(modeSnap.expires_in_ms / 60000);
      const hours = Math.floor(totalMin / 60);
      const minutes = totalMin % 60;
      return `fullauto (expires in ${hours}h ${minutes}m)`;
    }
    return 'fullauto';
  }
  return String(modeSnap.mode);
}

function formatStatusSummaryTable(summary) {
  if (!summary || !summary.ok) {
    return `Ralph status: unavailable (${summary && summary.reason})`;
  }
  const lines = [];
  lines.push(`Ralph status (checked at ${summary.checked_at}):`);
  lines.push('');
  lines.push(`Mode: ${formatModeLine(summary.mode)}`);
  lines.push('');

  const cost = summary.cost || {};
  if (cost.error) {
    lines.push('Cost: unavailable');
  } else {
    const pct = Math.round((cost.fraction || 0) * 1000) / 10;
    lines.push(`Cost: $${cost.daily_spend} / $${cost.daily_cap} (${pct}%)`);
  }
  lines.push('');

  const c = summary.counts || emptyCounts();
  lines.push(`Counts: ${c.queued} queued | ${c.running} running | ${c.waiting_approval} waiting | ${c.completed} done | ${c.failed} failed | ${c.stopped} stopped (total ${c.total})`);
  lines.push('');

  if (!summary.stories || summary.stories.length === 0) {
    lines.push('Stories: (none queued)');
  } else {
    lines.push('Stories:');
    for (const s of summary.stories) {
      const parts = [`  ${s.story_id}`, `[${s.status}/${s.current_phase}]`, `attempts=${s.attempts}/${s.max_attempts}`];
      if (s.pr_number != null) parts.push(`PR #${s.pr_number}`);
      if (s.last_verdict) parts.push(`verdict=${s.last_verdict}`);
      if (s.last_repair_instruction_present) parts.push('repair_pending');
      lines.push(parts.join(' '));
    }
  }
  return lines.join('\n');
}

function formatStatusSummaryJson(summary) {
  return JSON.stringify(summary, null, 2);
}

module.exports = { buildStatusSummary, formatStatusSummaryTable, formatStatusSummaryJson };
