# Soak Harness Runbook — Phase 1 #6 / #7

Status: production-ready as of 2026-05-14.

Purpose: run the Ralph autonomous loop **continuously and saturated** with
docs-only Risk-0 stories for hours-to-days, so we can observe cost
trajectory, escalation rate, disk usage, and worktree-leak behaviour that a
single one-shot dispatch cannot expose.

The harness is **not** the actual 24h Phase 1 #7 run — it is the infrastructure
that makes Phase 1 #7 possible. Phase 1 #7 is just running this harness for
24 hours and writing up the result.

## Components

| File | Purpose |
|---|---|
| `scripts/ralph/soak-story-supplier.js` | Continuous story generator. Emits docs-only Risk-0 stories at a configurable rate. Topics rotate deterministically across a bounded template library (glossary / decision / runbook / changelog). No LLM, no repo writes, no secrets. |
| `scripts/ralph/soak-harness.sh` | Detached-process orchestrator. Launches the daemon and the supplier under `nohup`, captures both pids and logs under `.ralph/soak/`, supports `status` / `tail` / `stop`. |
| `tests/ralph/soak-story-supplier.spec.js` | 11 unit tests covering rate clamping, template rotation, story-id uniqueness, dry-run, and Risk 0 shape. |

## Quick start (4h compressed validation soak)

```bash
# 1. Confirm env
cat /Users/hkobayashi/MCA/.env | grep -c OPENROUTER_API_KEY   # → 1

# 2. Start a 4h saturated run in approval mode at 30 stories/hour
scripts/ralph/soak-harness.sh start \
  --duration-hours 4 \
  --rate-per-hour 30 \
  --mode approval

# 3. Observe in another terminal
scripts/ralph/soak-harness.sh status
scripts/ralph/soak-harness.sh tail daemon
scripts/ralph/soak-harness.sh tail supplier
node scripts/ralph/dashboard.js --markdown | head -80

# 4. (when done) stop cleanly
scripts/ralph/soak-harness.sh stop
```

## Quick start (overnight 24h Phase 1 #7 run)

The defaults are tuned for an overnight run.

```bash
# 1. Pre-flight: clean working tree
git status --porcelain        # → empty
docker info                    # → daemon running (needed for supabase-local gate)

# 2. (Optional) flip mode to fullauto so stories reach DONE without /approve
node src/ralph/cli.js mode fullauto-request 1 24
# → take the MODE-... token, then:
node src/ralph/cli.js mode fullauto-confirm MODE-... 1

# 3. Start the harness
scripts/ralph/soak-harness.sh start \
  --duration-hours 24 \
  --rate-per-hour 30 \
  --mode fullauto

# 4. Walk away. The daemon stops at 24h via --max-cycles; supplier keeps
#    going until the daemon exits or supplier hits --supplier-max-stories.

# 5. Morning review (next day):
scripts/ralph/soak-harness.sh status
node scripts/ralph/dashboard.js --markdown | head -120
scripts/ralph/soak-harness.sh stop      # if anything is still running
```

## Configuration

All flags on `soak-harness.sh start` (see `--help`):

| Flag | Default | Bounds | Effect |
|---|---|---|---|
| `--duration-hours N` | 0 (unbounded) | 0..∞ | If > 0, daemon `--max-cycles` is computed so the daemon self-exits at N hours. |
| `--rate-per-hour N` | 30 | 1..240 | Supplier emit rate. 30/h = 1 story every 2 minutes. |
| `--supplier-max-stories N` | 0 (unbounded) | 0..∞ | Hard cap on supplier emissions. |
| `--mode approval\|fullauto` | approval | { approval, fullauto } | Mode persisted on each seeded story. |
| `--interval-ms N` | 60000 (1 min) | ≥ 1000 | Daemon cycle interval. |
| `--limit N` | 25 | 1..25 | Stories processed per daemon cycle. 25 = all runnable in a single cycle. |
| `--ticks-per-story N` | 3 | 1..12 | Inner ticks per story per cycle. |
| `--env-file PATH` | `/Users/hkobayashi/MCA/.env` | — | Sourced before launch. Must export `OPENROUTER_API_KEY`. |
| `--dry-supplier` | (off) | — | Supplier runs in dry-run mode (logs would-be stories but does not create them). Useful to validate the harness layout without spending tokens. |

## Cost model

Per the Phase 0 soak (`docs/soak-2026-05-14-summary.md`) and the Phase 1 #2
end-to-end run, docs-only Risk-0 stories cost roughly **\$0.007 each** through
Kimi K2.6 via OpenRouter:

| Run shape | Stories | Estimated cost |
|---|---|---|
| 4h @ 30/h compressed validation | 120 | ~\$0.84 |
| 8h @ 30/h overnight half | 240 | ~\$1.70 |
| 24h @ 30/h overnight full | 720 | ~\$5.00 |
| 24h @ 60/h aggressive | 1440 | ~\$10 |

Hard ceilings: configure `--supplier-max-stories` if you want a strict budget
cap independent of wall clock.

## Observed outcomes (Phase 0 24-story soak, for reference)

```
24 / 24 stories reached the appropriate approval boundary
19 / 19 dispatched stories produced clean candidate patches
 5 / 24 stories correctly gated at PLAN_APPROVAL_PENDING (policy-correct,
        risk evaluator triggered on 'policy' / 'token' / 'api key' keywords
        in the requirement text)
 0 escalations / failures / worktree leaks
 ~536 KB final .ralph/ disk usage
 ~$0.14 total cost
```

The continuous supplier should reproduce that same shape at scale, with the
added concern that **approval mode** accumulates pending approvals (every
DIFF/COMMIT/PUSH/PR boundary requires a human `/approve`). For a hands-off
overnight run, **fullauto mode** is the realistic choice — DIFF/COMMIT/PUSH/PR
are auto-approved; PLAN and RESUME still require a human.

## Safety posture (unchanged from Phase 1 #5)

- Stories are Risk 0 with `target_env='local'`. They never touch production.
- `requested_paths` is always a single `docs/soak/<topic>-<seq>.md` path that
  does not exist in the repository. The deterministic candidate-patch
  fallback can therefore cover Kimi K2.6 outages without policy violations.
- The autonomous loop default dispatcher is OpenCode + Kimi K2.6 direct
  (since ADR-2026-05-14). `apply_allowed` / `commit_allowed` / `push_allowed`
  / `pr_allowed` / `merge_allowed` / `deploy_allowed` / `migration_allowed`
  remain `false` at the dispatcher boundary.
- The supplier never invokes the LLM. It only calls `createStory` from
  `src/ralph/story-queue`.
- Even in fullauto mode, PLAN approvals are not auto-approved. The risk
  evaluator's substring scan over `requirement` may trigger PLAN approvals
  on stories that mention `policy` / `token` / `api key`; those will park at
  PLAN_APPROVAL_PENDING and require a human.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `daemon status: EXITED EARLY` | env file missing or `OPENROUTER_API_KEY` not set | `cat $ENV_FILE \| grep OPENROUTER_API_KEY`; if empty, edit `/Users/hkobayashi/MCA/.env` |
| `supplier status: EXITED EARLY` | bad `--rate-per-hour` (e.g. 0) | restart with `--rate-per-hour 30` |
| Disk usage grows quickly | a stuck `.ralph/sandboxes/*/worktree` is not being torn down | `git worktree list`; if stale entries, `git worktree prune` |
| Stories pile up at DIFF_APPROVAL_PENDING | running in approval mode | expected; either approve via Telegram / CLI, or restart in `--mode fullauto` |
| Stories pile up at OPENCODE_RUNNING | dispatcher is failing (rate limit, OpenRouter outage, etc.) | inspect `.ralph/logs/audit.jsonl` and `tail $DAEMON_LOG`; the `attempts → ESCALATED` guard moves them off the runnable queue at `max_attempts=2` |
| `attempts: 2 status: failed` for many stories | persistent provider failure | `scripts/ralph/soak-harness.sh stop` and investigate before resuming |
| Cost exceeding budget on OpenRouter dashboard | `--rate-per-hour` too high, or stuck stories retrying | stop, reduce rate, or set `--supplier-max-stories` |

## What this PR does NOT include

Phase 1 #7 (the actual 24h saturated run) is a **separate exercise** that
uses this harness. The result will be recorded in a separate report
(`docs/soak-24h-fullauto-<date>.md`) and a separate PR.

This PR ships:

1. The supplier module and its 11 unit tests.
2. The harness shell script (validated syntactically + on a small dry-supplier run).
3. This runbook.
4. A short compressed validation soak (~30 min wall clock, ~15 stories) whose
   findings live in the PR body.
