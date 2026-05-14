#!/usr/bin/env node
/**
 * Continuous story supplier for 24h saturated soak runs.
 *
 * Emits docs-only Risk-0 stories at a configurable rate so the autonomous
 * daemon never goes idle. Topics rotate deterministically across a bounded
 * template library; the supplier itself never invokes the LLM and never
 * touches the repository working tree.
 *
 * Each story:
 *   - status: 'queued'
 *   - mode: configurable (default 'approval' so risk_evaluator runs normally)
 *   - target_env: 'local'
 *   - risk: { score: 0, category: 'low', label: 'RISK_0_LOW' }
 *   - requested_paths: exactly one docs/soak/<topic>-<seq>.md path
 *   - max_attempts: 2 (so a stuck story does not eat the supplier queue)
 *
 * Operator-facing surface:
 *   node scripts/ralph/soak-story-supplier.js \
 *     --rate-per-hour 30 \      (default 30; max 240)
 *     --max-stories 0 \         (default 0 = unbounded)
 *     --mode approval \         (or 'fullauto')
 *     --story-prefix SOAK-A \   (default SOAK; appended with timestamp+seq)
 *     --dry-run                 (print what would be seeded, do not write)
 *
 * Stops cleanly on SIGINT / SIGTERM. Resumes from the persisted sequence
 * counter in .ralph/soak/supplier-state.json so restarts do not duplicate
 * story ids.
 */
const fs = require('node:fs');
const path = require('node:path');

const { createStory } = require('../../src/ralph/story-queue');

const SUPPLIER_VERSION = 'soak_story_supplier_v0_1';
const MIN_RATE_PER_HOUR = 1;
const MAX_RATE_PER_HOUR = 240;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const STATE_DIR_REL = '.ralph/soak';
const LOG_PATH_REL = '.ralph/logs/supplier.jsonl';

const TEMPLATES = [
  {
    family: 'glossary',
    topics: [
      ['risk-score', 'Glossary: risk score', 'Define the Ralph risk score (0..5) in 4-6 sentences. Mention Risk 3a/3b/3c/3d split and Risk 5 = STOP.'],
      ['plan-hash', 'Glossary: plan hash', 'Define plan_hash in 4-6 sentences. Mention canonical JSON, sha256 prefix, and stability across semantically identical plans.'],
      ['diff-hash', 'Glossary: pre/post diff hash', 'Define pre_exec_diff_hash and post_exec_diff_hash in 4-6 sentences. Mention they are computed against git diff at the wired-loop boundary.'],
      ['kimi-k2.6', 'Glossary: Kimi K2.6 dispatcher', 'Define the OpenCode + Kimi K2.6 dispatcher (current default) in 4-6 sentences. Mention OpenRouter routing and env scrubbing.'],
      ['worktree-sandbox', 'Glossary: per-story worktree sandbox', 'Define the per-story git worktree sandbox in 4-6 sentences. Mention sandbox_root prefix allow-list and unconditional teardown.'],
      ['fullauto-window', 'Glossary: fullauto window', 'Define the fullauto window in 4-6 sentences. Mention admin + confirm + DEFAULT_FULLAUTO_HOURS=6 + MAX_FULLAUTO_HOURS=24.'],
      ['resume-after-stop', 'Glossary: RESUME_AFTER_SECURITY_STOP', 'Define the resume-after-security-stop workflow in 4-6 sentences. Mention admin only, single-use, never fullauto.']
    ]
  },
  {
    family: 'decision',
    topics: [
      ['phase0-trunk', 'Decision: phase0 branch is the trunk', 'Record the decision that infra/phase0-autonomous-foundation is the canonical trunk during Phase 0/1. Mention defaultBranchRef and that main does not yet exist.'],
      ['kimi-default', 'Decision: opencode-kimi is default dispatcher', 'Record the ADR-2026-05-14 decision to promote OpenCode + Kimi K2.6 to default and demote NemoClaw to opt-in.'],
      ['mode-json-gitignored', 'Decision: untrack mode.json and state.json', 'Record the decision to untrack .ralph/mode.json and .ralph/state.json from git (Phase 1 #2).'],
      // NOSCAN-FIXTURE: the slug "risk-evaluator-conservative" contains the literal sk-evaluator-conservative substring which trips the openai sk-* regex; this is a template label, not a secret.
      ['risk-evaluator-conservative', 'Decision: risk evaluator stays conservative', 'Record the decision to keep the substring-based risk_evaluator (touchesSecrets/touchesRls etc.) even though it gates many docs stories at PLAN_APPROVAL_PENDING.'],
      ['fullauto-pl-excludes-plan', 'Decision: PLAN approval never auto-approved', 'Record the decision that even in fullauto, PLAN approvals require a human; only DIFF/COMMIT/PUSH/PR are auto-approved.']
    ]
  },
  {
    family: 'runbook',
    topics: [
      ['overnight-soak', 'Runbook: overnight saturated soak', '4-6 step runbook for starting an overnight soak with scripts/ralph/soak-harness.sh, monitoring it via tail and dashboard, and stopping cleanly.'],
      ['kimi-cost-check', 'Runbook: weekly Kimi cost check', '4-6 step runbook for checking OpenRouter token spend per week against the design budget.'],
      ['restart-stuck-supplier', 'Runbook: restart the soak supplier', '4-6 step runbook for stopping and resuming scripts/ralph/soak-story-supplier.js without duplicating story ids.'],
      ['drain-pending-approvals', 'Runbook: drain pending approvals at morning review', '4-6 step runbook for inspecting and approving the parked DIFF/COMMIT/PUSH/PR approvals after an overnight approval-mode soak.'],
      ['security-stop-triage', 'Runbook: triage a security-stopped story', '4-6 step runbook for investigating and either resuming or formally closing a STOPPED_SECURITY story.']
    ]
  },
  {
    family: 'changelog',
    topics: [
      ['phase1-summary', 'Changelog: Phase 1 #1..#5 summary', 'One-paragraph changelog entry summarizing PRs #45 #46 #47 #48 #49 #50 #51 #52 #53 in 4-6 sentences.'],
      ['kimi-dispatcher-fixes', 'Changelog: dispatcher contract fixes', 'One-paragraph changelog entry summarizing the worktree-prompt rewrite, classify-order swap, soft-timeout downgrade from PR #46.'],
      ['fullauto-resume-telegram', 'Changelog: fullauto + resume + Telegram surface', 'One-paragraph changelog entry summarizing fullauto auto-approver, resume-after-security-stop, and the Telegram /resume-request /resume-status commands.']
    ]
  }
];

function flattenTemplates() {
  const flat = [];
  for (const fam of TEMPLATES) for (const t of fam.topics) flat.push({ family: fam.family, slug: t[0], title: t[1], requirement: t[2] });
  return flat;
}

const FLAT_TEMPLATES = flattenTemplates();

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const value = (name, fallback = undefined) => {
    const i = argv.indexOf(name);
    if (i === -1) return fallback;
    return argv[i + 1];
  };
  const has = (n) => argv.includes(n);
  const rate = Number.parseFloat(value('--rate-per-hour', env.SOAK_RATE_PER_HOUR || '30'));
  const maxStories = Number.parseInt(value('--max-stories', env.SOAK_MAX_STORIES || '0'), 10);
  return {
    rate_per_hour: Number.isFinite(rate) ? Math.min(MAX_RATE_PER_HOUR, Math.max(MIN_RATE_PER_HOUR, rate)) : 30,
    max_stories: Number.isFinite(maxStories) && maxStories >= 0 ? maxStories : 0,
    mode: value('--mode', env.SOAK_MODE || 'approval'),
    story_prefix: value('--story-prefix', env.SOAK_STORY_PREFIX || 'SOAK'),
    rootDir: value('--root', process.cwd()),
    dry_run: has('--dry-run')
  };
}

function intervalMsForRate(ratePerHour) {
  const ms = Math.round((3600 * 1000) / ratePerHour);
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
}

function stateDir(rootDir) {
  return path.join(rootDir, STATE_DIR_REL);
}

function loadSupplierState(rootDir) {
  const file = path.join(stateDir(rootDir), 'supplier-state.json');
  if (!fs.existsSync(file)) return { seq: 0 };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { seq: 0 };
  }
}

function saveSupplierState(rootDir, state) {
  const dir = stateDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'supplier-state.json'), `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

function appendSupplierLog(rootDir, entry) {
  const file = path.join(rootDir, LOG_PATH_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function nextTemplate(seq) {
  if (FLAT_TEMPLATES.length === 0) return null;
  return FLAT_TEMPLATES[seq % FLAT_TEMPLATES.length];
}

function pickRequestedPath(template, seq) {
  return `docs/soak/${template.family}-${template.slug}-${String(seq).padStart(6, '0')}.md`;
}

function buildStoryInput({ template, seq, mode, story_prefix, now }) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const storyId = `STORY-${story_prefix}-${stamp}-${String(seq).padStart(6, '0')}`.slice(0, 80);
  return {
    story_id: storyId,
    title: template.title,
    requirement: template.requirement,
    requested_paths: [pickRequestedPath(template, seq)],
    priority: 50,
    mode,
    target_env: 'local',
    risk: { score: 0, category: 'low', label: 'RISK_0_LOW' },
    max_attempts: 2,
    labels: ['soak', template.family]
  };
}

function emitOnce({ rootDir, mode, story_prefix, dry_run, state, now }) {
  const template = nextTemplate(state.seq);
  if (!template) return { ok: false, reason: 'no_templates' };
  const input = buildStoryInput({ template, seq: state.seq, mode, story_prefix, now });
  if (dry_run) {
    appendSupplierLog(rootDir, { event: 'supplier_dry_run', story_id: input.story_id, family: template.family, slug: template.slug, requested_paths: input.requested_paths });
    return { ok: true, story_id: input.story_id, family: template.family, slug: template.slug, dry_run: true };
  }
  const result = createStory(input, { rootDir, now });
  if (result.ok) {
    appendSupplierLog(rootDir, { event: 'supplier_story_created', story_id: input.story_id, family: template.family, slug: template.slug, requested_paths: input.requested_paths });
    return { ok: true, story_id: input.story_id, family: template.family, slug: template.slug, dry_run: false };
  }
  appendSupplierLog(rootDir, { event: 'supplier_story_create_failed', story_id: input.story_id, reason: result.reason });
  return { ok: false, reason: result.reason || 'create_failed', story_id: input.story_id };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSupplier(options) {
  const rootDir = options.rootDir;
  const intervalMs = intervalMsForRate(options.rate_per_hour);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once?.('SIGINT', stop);
  process.once?.('SIGTERM', stop);

  const startedAt = new Date();
  appendSupplierLog(rootDir, {
    event: 'supplier_started',
    version: SUPPLIER_VERSION,
    rate_per_hour: options.rate_per_hour,
    interval_ms: intervalMs,
    max_stories: options.max_stories,
    mode: options.mode,
    story_prefix: options.story_prefix,
    dry_run: options.dry_run
  });

  let state = loadSupplierState(rootDir);
  let emitted = 0;
  while (!stopped) {
    const result = emitOnce({ rootDir, mode: options.mode, story_prefix: options.story_prefix, dry_run: options.dry_run, state, now: new Date() });
    if (result.ok) {
      emitted += 1;
      state.seq += 1;
      saveSupplierState(rootDir, state);
      console.log(JSON.stringify({ event: 'emit_ok', story_id: result.story_id, seq: state.seq - 1, family: result.family, slug: result.slug, emitted_so_far: emitted }));
    } else {
      console.log(JSON.stringify({ event: 'emit_fail', reason: result.reason, seq: state.seq }));
    }
    if (options.max_stories > 0 && emitted >= options.max_stories) break;
    await sleep(intervalMs);
  }

  const finishedAt = new Date();
  appendSupplierLog(rootDir, {
    event: 'supplier_stopped',
    emitted,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    stopped_by_signal: stopped
  });
  return { ok: true, emitted, started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString() };
}

if (require.main === module) {
  const options = parseArgs();
  runSupplier(options).then((r) => {
    if (!r.ok) process.exitCode = 1;
  }).catch((err) => {
    console.error(JSON.stringify({ event: 'supplier_error', reason: err.message }));
    process.exitCode = 1;
  });
}

module.exports = {
  SUPPLIER_VERSION,
  TEMPLATES,
  FLAT_TEMPLATES,
  parseArgs,
  intervalMsForRate,
  nextTemplate,
  pickRequestedPath,
  buildStoryInput,
  emitOnce,
  runSupplier
};
