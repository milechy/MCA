# Telegram Operator Runbook — Phase 1 (approval + fullauto + resume)

Status: production-ready for Phase 0 trunk operation, reflects PR #45/46/47/49/50/51 and the Phase 1 #4 Telegram surface additions.

This runbook is what an on-call operator should follow when standing up the Telegram bot end-to-end. It assumes the local Ralph daemon and OpenCode + Kimi K2.6 dispatcher are already configured (see `docs/ralph-detailed-design-v0.2.md`).

## Required environment

```bash
# Bot identity (issued by @BotFather)
export TELEGRAM_BOT_TOKEN='1234567890:AAEhBP0av1...'

# Numeric user_id allow-list (Telegram /myid via @userinfobot)
export TELEGRAM_ALLOWED_USER_IDS='12345678,87654321'

# Numeric chat_id allow-list (group or DM ids)
export TELEGRAM_ALLOWED_CHAT_IDS='-1001234567890,12345678'

# Required for safe operation: bot starts in dry-run unless explicitly disabled
# export TELEGRAM_DRY_RUN='false'   # only after the operator has tested in dry-run

# Required for autonomous PR creation through the bot's /approve path
export OPENROUTER_API_KEY='sk-or-v1-...'

# Required for autonomous PR creation
export RALPH_DISPATCHER=opencode-kimi
```

Persist these in `~/MCA/.env` (chmod 600) and source via the daemon launcher.

## Roles file

The admin gate for `/mode fullauto-request` and `/resume-request` reads `.ralph/roles.json` (gitignored). Set this once on the deploy host:

```bash
cat > .ralph/roles.json <<'JSON'
{
  "admin_user_ids":   [12345678],
  "owner_user_ids":   [12345678],
  "reviewer_user_ids": [12345678, 87654321]
}
JSON
chmod 600 .ralph/roles.json
```

- `admin_user_ids` / `owner_user_ids` — required for `/mode fullauto-request` and `/resume-request`.
- `reviewer_user_ids` — required for `/approve`, `/deny`, `/modify`. Admins and owners are reviewers by default.

A non-admin user_id receives `admin_required` on any admin-gated command and the underlying state is never touched.

## Approval boundaries the bot drives

| Phase | Approval id prefix | Command | Mode behaviour |
|---|---|---|---|
| PLAN | `APR-PLAN-…` | `/approve <id>` | approval: human only. fullauto: still human (PLAN is never auto-approved) |
| DIFF | `APR-OPENCODE-APPLY-…` | `/approve <id>` | approval: human. fullauto: auto-approved if risk < 4 and target_env ≠ production with risk ≥ 3 |
| COMMIT | `APR-OPENCODE-COMMIT-…` | `/approve <id>` | as DIFF |
| PUSH | `APR-OPENCODE-PUSH-…` | `/approve <id>` | as DIFF (legacy `approval_type='plan'` recognized via prefix) |
| PR | `APR-OPENCODE-PR-…` | `/approve <id>` | as DIFF (legacy `approval_type='plan'` recognized via prefix) |
| MODE | `MODE-…` token | `/confirm <token>` | admin only |
| RESUME | `APR-RESUME-…` | `/approve <id>` | **never auto-approved**, even in fullauto |

## Command reference (Phase 1 surface)

### Read-only / status

```text
/ping
/status
/policy
/approvals
/approval <approval_id>
/ralph-plan <story.json>
/ralph-gate-manifest
/ralph-loop-status [story_id]
/resume-status <story_id>
```

### Approval lifecycle

```text
/approve <approval_id>             # any reviewer
/deny    <approval_id>             # any reviewer
/modify  <approval_id> <instruction>   # any reviewer → forces REPLAN
/resume-request <story_id> <rationale...>  # admin only, story must be STOPPED
```

The `/resume-request` rationale is redacted server-side (GitHub PATs, emails, `sk-or-*`, `password|secret|token|api_key|service_role = …`) and must be ≥ 8 chars after redaction. The reply is the new `APR-RESUME-…` id; an admin then approves it the same way as any other approval (`/approve <APR-RESUME-…>`). After approval, the daemon picks the story up, transitions it back to `PLAN_APPROVAL_PENDING`, marks the resume approval `EXECUTED`, and records `last_resume_approval_id` on the story.

### Mode transitions

```text
/mode approval                     # any reviewer → immediate
/mode fullauto                     # admin only → emits MODE-…; window default 6h, max 24h
/confirm MODE-<token>              # admin only → activates the fullauto window
```

A fullauto window auto-reverts to approval at `effective_until`. While fullauto is active, the daemon auto-approves DIFF/COMMIT/PUSH/PR within the risk budget; PLAN and RESUME stay human-gated.

### Autonomous loop control

```text
/ralph-start <requirements>
/ralph-tick <story_id>
/ralph-run-until-blocked <story_id>
/ralph-pause <story_id>
/ralph-resume <story_id>           # NB: this is loop-resume, NOT security-resume
/ralph-stop <story_id>
/ralph-artifact <story_id>
```

## Phase 1 #1–#3 walkthrough (Telegram-driven)

### Walkthrough A — approval-mode story to merged PR

```text
op:  /ralph-start Add a docs/glossary/clamp.md note about the clamp helper
bot: STORY-… seeded. Plan written. Next approval: APR-…

op:  /approve APR-PLAN-…
bot: Plan approved. Dispatch to OpenCode. … emits APR-OPENCODE-APPLY-…

op:  /approve APR-OPENCODE-APPLY-…
bot: Patch applied. Gates passed. … emits APR-OPENCODE-COMMIT-…

op:  /approve APR-OPENCODE-COMMIT-…
bot: Commit landed. … emits APR-OPENCODE-PUSH-…

op:  /approve APR-OPENCODE-PUSH-…
bot: Branch pushed to origin. … emits APR-OPENCODE-PR-…

op:  /approve APR-OPENCODE-PR-…
bot: PR <url> created. Story DONE.
```

### Walkthrough B — fullauto window

```text
op (admin): /mode fullauto
bot:        MODE-20260514-xxxx issued. /confirm to activate.

op (admin): /confirm MODE-20260514-xxxx
bot:        fullauto active until 2026-05-14T11:09:08+09:00.

op:         /ralph-start ...
bot:        STORY-… seeded.
            (daemon auto-approves DIFF/COMMIT/PUSH/PR; PLAN still needs op /approve)

op:         /approve APR-PLAN-…
bot:        (autonomous progression … final PR url emitted to chat)
```

To shorten the window:

```text
op (admin): /mode approval
bot:        fullauto revoked. now in approval mode.
```

### Walkthrough C — recovering a security-stopped story

A story can land in `STOPPED_SECURITY` from Risk 5, secret-policy violation, RLS/auth violation, or production-DB destructive intent. The autonomous loop will not move it out without an explicit human-recorded resume.

```text
op (admin): /resume-status STORY-…
bot:        current_phase=STOPPED_SECURITY, is_security_stopped=true,
            pending_approved_resume_approval_id=null

op (admin): /resume-request STORY-… root cause was a false positive in scanning regex, sanitized and confirmed safe
bot:        APR-RESUME-STORY-…-20260514… issued. Admin must /approve to consume.

op (admin): /approve APR-RESUME-STORY-…-20260514…
bot:        Approval marked approved.

(within one daemon cycle)
bot:        STORY-… resumed: STOPPED_SECURITY → PLAN_APPROVAL_PENDING.
            Risk evaluator will re-run on the next tick.

op:         /resume-status STORY-…
bot:        current_phase=PLAN_APPROVAL_PENDING, is_security_stopped=false,
            last_resume_approval_id=APR-RESUME-STORY-…-20260514…,
            pending_approved_resume_approval_id=null
```

The resume approval is single-use; a second stop on the same story requires a new `/resume-request`.

## Safety invariants the bot enforces (do not bypass)

1. **user_id + chat_id allow-list.** Any update from a user or chat not in both env lists is rejected before any handler runs.
2. **PLAN is never auto-approved.** Even in fullauto, PLAN approvals require a human.
3. **RESUME is never auto-approved.** Even in fullauto, an admin must explicitly `/approve` the `APR-RESUME-…` id after `/resume-request`.
4. **Risk 5 stops, every mode.** No `/mode`, `/approve`, or `/confirm` can promote a Risk 5 decision into execution; only `/resume-request` + admin approval can move past it, and that re-runs risk evaluation.
5. **Risk ≥ 4 in fullauto still requires human.** PLAN at risk 4 stays at PLAN_APPROVAL_PENDING regardless of fullauto.
6. **production target_env + Risk ≥ 3 still requires human.** Even in fullauto. Even at apparent low score for the gate kind.
7. **Single-use resume.** `APR-RESUME-…` records flip to `EXECUTED` on consume; cannot be replayed.
8. **`/modify` always supersedes and forces REPLAN.** It never mutates the existing approval; a new approval id is issued with a fresh plan_hash.
9. **`gh` subprocess inputs validated.** `repository_full_name`, `head`, `base` must match safe-shape regex; `OPENROUTER_API_KEY` / `GITHUB_TOKEN` are the only secrets exposed to the spawned PR-creation subprocess.
10. **OpenCode subprocess env scrubbed.** Kimi K2.6 only sees `PATH`, `HOME`, `TMPDIR`, `CI`, `OPENROUTER_API_KEY`, `OPENCODE_DISABLE_TELEMETRY=1` — production secrets never reach the agent.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unauthorized Telegram command.` | user_id or chat_id not in env | add to `TELEGRAM_ALLOWED_USER_IDS` / `TELEGRAM_ALLOWED_CHAT_IDS` and restart daemon |
| `Approve failed: approval_status_approved` | duplicate /approve on same approval_id | the record is already approved; no action needed, daemon will progress |
| `Resume request failed: admin_required` | requester not in `roles.json` admin/owner | add user_id to `.ralph/roles.json` |
| `Resume request failed: story_not_in_security_stop_state` | story is not in STOPPED_SECURITY / STOPPED | `/resume-status` to confirm; resume is only for stopped stories |
| `Resume request failed: rationale_too_short_min_8_chars` | rationale too short after redaction | rewrite rationale with more concrete language (≥ 8 non-secret chars) |
| Story stuck at `OPENCODE_RUNNING` for > N attempts | repeatedly failing dispatcher; expected escalation | `/ralph-loop-status <story_id>` — `attempts`/`max_attempts` and the autonomous-loop-wired escalator move it to ESCALATED at `max_attempts` |
| `Confirm failed: confirmation_expired` | took too long to `/confirm` | re-run `/mode fullauto` to issue a new MODE-… token |
| PR created but body is bare default | autonomous loop fell back to default body | review the approval body field; usually means the PR-approval phase had no captured plan body |

## Rollout checklist (operator)

- [ ] `TELEGRAM_BOT_TOKEN` set, bot is `BotFather` `started` with privacy ON
- [ ] `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS` set to expected ids
- [ ] `TELEGRAM_DRY_RUN=true` for first run, replies appear in chat only after flipping to false
- [ ] `.ralph/roles.json` populated with the operator's user_id as admin
- [ ] `OPENROUTER_API_KEY` present (verify with `node -e \"console.log((process.env.OPENROUTER_API_KEY||'').length)\"`)
- [ ] `gh auth status` shows logged in with `repo` + `workflow` scopes
- [ ] `RALPH_DISPATCHER=opencode-kimi` in env
- [ ] daemon launched via `nohup` and PID file recorded
- [ ] `/ping` returns `pong`
- [ ] `/status` returns a dashboard JSON
- [ ] `/resume-status STORY-…` works against any story id (read-only path)
- [ ] `/mode fullauto` + `/confirm` works for the admin only; non-admin sees `admin_required`
- [ ] One full approval-mode walkthrough (Walkthrough A) completes successfully

## Audit and observability

- `.ralph/logs/audit.jsonl` — bounded structured log of every approval, mode change, resume request, and consumption event.
- `.ralph/approval-log.jsonl` — append-only approval lifecycle log (request, approved_record_only, denied, superseded, executed, etc.).
- `node scripts/ralph/dashboard.js --markdown` — read-only dashboard of all stories and their phases (no secrets / no raw logs).
- The Telegram replies themselves include a fenced JSON block with the bounded handler result; raw logs and secret values are never echoed to chat.
