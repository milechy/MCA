# ADR: Retire NemoClaw as the default execution mediator; promote OpenCode + Kimi K2.6 direct dispatcher

Status: accepted (2026-05-14)
Owner: Ralph autonomous-loop infrastructure
Phase: 1 #5

## Context

The Ralph autonomous loop was originally designed around three execution paths:

1. **NemoClaw mediator** (default): `nemoclaw` + `openshell` + `openclaw` chain. NemoClaw enforces the candidate-patch-only policy; `openshell sandbox exec ... openclaw agent --message <bounded prompt>` actually runs the LLM. The mediator is the authoritative policy boundary for "no apply, no commit, no push, no PR, no shell escalation, no raw logs, no secret display".
2. **Direct OpenCode (dev-only)**: bypass NemoClaw entirely. Gated behind `RALPH_OPENCODE_DIRECT_DEV_ONLY=true`, never default.
3. **OpenCode + Kimi K2.6 direct** (added in PR #45/#46): same OpenCode runtime as path 2, but with a hardened dispatcher that re-implements the relevant NemoClaw policy enforcement (candidate.patch-only, env scrubbing, requested_paths regex validation) in JavaScript inside `src/ralph/opencode-kimi-dispatcher.js`. Gated behind `RALPH_DISPATCHER=opencode-kimi`.

Observed reality on the current development host (Phase 0 deploy host, macOS arm64) at the time of this decision:

```
$ which nemoclaw openclaw openshell
/Users/hkobayashi/.local/bin/nemoclaw     v0.0.38   INSTALLED
                                          openclaw  MISSING
/Users/hkobayashi/.local/bin/openshell    v0.0.36   INSTALLED
```

`openclaw` — the binary NemoClaw actually invokes inside `openshell` — is not installed and is not available through any public package or `brew` formula we have access to. It is a vendor-internal tool. The original Phase 0 plan assumed access to it; that assumption has not held.

The practical consequence:

- Without `openclaw`, the NemoClaw path returns `nemoclaw_runtime_timeout` on every dispatch.
- PR #45 added `nemoclaw_runtime_timeout` to `FALLBACK_FAILURE_REASONS` so a missing runtime degrades to the deterministic fallback rather than blocking the loop forever — but the deterministic fallback only handles very narrow cases (single requested path, docs/tests/.github/, file does not yet exist).
- For anything outside that narrow window, the autonomous loop stays stuck or escalates to `ESCALATED`. Stories never reach `DIFF_APPROVAL_PENDING`.
- Operators have been working around this by setting `RALPH_DISPATCHER=opencode-kimi` on every daemon launch. Every PR #45-onwards merge has used this opt-in.

Meanwhile, the OpenCode + Kimi K2.6 path has been thoroughly verified:

- Real Kimi K2.6 benchmark: **3/3** (easy + medium + medium-hard tasks, all patches `git apply --check` clean, all generated tests pass when applied) — PR #46.
- 24-story headless soak (`docs/soak-2026-05-14-summary.md`): 19/19 dispatched stories produced clean candidate patches, 5 correctly gated at `PLAN_APPROVAL_PENDING`, **0 escalations / failures / worktree leaks** at ~$0.14 total cost.
- Live Phase 1 #1 PR #49: autonomous loop drove the full chain end-to-end and created its own PR.
- Live Phase 1 #2 PR #50: fullauto-mode autonomous loop reached DONE in ~90 s wall clock, also self-created the PR.

The OpenCode + Kimi K2.6 dispatcher has been the de-facto production path for the last 5 PRs.

## Options considered

### Option A: Install `openclaw` on the deploy host

- `openclaw` is not OSS; no public install path.
- Would require vendor cooperation (Moonshot AI internal tooling) and licensing review.
- Result is unclear: even after install, the NemoClaw path has never been exercised end-to-end in this codebase.
- Effort: high. Outcome: unknown. Lock-in: high.

### Option B: Retire the entire NemoClaw stack from the codebase

- Delete `src/ralph/nemoclaw-policy.js`, `src/ralph/nemoclaw-opencode-gateway.js`, all related tests.
- Simplify `buildDefaultOpenCodeDispatcher` to just call `dispatchOpenCodeKimi`.
- Risk: we lose the *policy spec* expressed in `nemoclaw-policy.js`. That file is the authoritative enumeration of what an execution mediator is and is not allowed to do (candidate.patch only, apply/commit/push/PR/deploy/migration/merge/shell denied, raw logs denied, secret display denied, bounded redaction required). Throwing it away in favour of "the Kimi dispatcher does the right thing" weakens the system's policy story.
- Effort: medium. Outcome: cleaner code, weaker policy spec.

### Option C: Promote Kimi-direct to default; keep NemoClaw modules as the *policy spec* and a future mediator option

- Flip `buildDefaultOpenCodeDispatcher` to call `dispatchOpenCodeKimi` when no `RALPH_DISPATCHER` is set.
- Add explicit opt-in `RALPH_DISPATCHER=nemoclaw` to access the NemoClaw path (becomes a back-compatibility / "if you later install openclaw" path).
- Keep `nemoclaw-policy.js` as the authoritative policy spec (every dispatcher boundary, including the new Kimi path, can cite it).
- Annotate `nemoclaw-opencode-gateway.js` with a deprecation note pointing operators to `RALPH_DISPATCHER` and the ADR.
- Effort: low. Outcome: default is what already works; policy spec preserved; back-compatible opt-in retained.

## Decision

**Adopt Option C.** Concretely:

1. `buildDefaultOpenCodeDispatcher` in `src/ralph/autonomous-loop.js` chooses dispatchers in this order:
   - sandbox preflight failure → return preflight diagnostic.
   - `RALPH_DISPATCHER` explicitly set to `nemoclaw` → `runNemoClawOpenCodeCandidatePatch` (legacy / opt-in).
   - `RALPH_OPENCODE_DIRECT_DEV_ONLY === 'true'` → direct (dev-only).
   - Default → `dispatchOpenCodeKimi`. (PR #45+ semantics — Kimi K2.6, worktree, env scrubbing.)
   
   `RALPH_DISPATCHER=opencode-kimi` continues to be accepted as an explicit opt-in for symmetry, but is now redundant with the default.

2. `nemoclaw-opencode-gateway.js` gains a `/** @deprecated 2026-05-14 …  */` doc header pointing at this ADR. The module is not removed; the policy boundary it implements is still consulted by `src/ralph/external-agent-gateway.js` and friends.

3. `nemoclaw-policy.js` is **retained** as the authoritative policy spec. Documentation cross-references it from the Kimi dispatcher.

4. Tests that asserted `mediator: 'nemoclaw'` as the default switch to assert the new default (`mediator: 'opencode-direct'`, `opencode_runtime_mode: 'opencode-kimi-direct'`). NemoClaw-specific tests (`tests/ralph/nemoclaw-opencode-gateway.spec.js`, `tests/ralph/external-agent-gateway.spec.js`) continue to run NemoClaw via explicit opt-in.

5. The Telegram operator runbook (PR #52, `docs/telegram-phase1-operator-runbook.md`) is updated to drop the implicit "default is NemoClaw" language.

6. The detailed-design doc (PR #47, `docs/ralph-detailed-design-v0.2.md` §8/§9) is updated to reflect "Kimi-direct is the default dispatcher; NemoClaw is opt-in via `RALPH_DISPATCHER=nemoclaw`."

## Consequences

### Positive

- A fresh clone of the repo with only `OPENROUTER_API_KEY` and `gh auth` configured can run the autonomous loop end-to-end. No `RALPH_DISPATCHER=opencode-kimi` boilerplate, no `openclaw` install requirement.
- The mismatch between "documented default" and "the path operators actually use" disappears.
- The NemoClaw policy module remains the authoritative policy spec, so future mediator implementations (e.g. a real `openclaw` install, or a different vendor's mediator) can be added without re-litigating the boundary rules.
- The deterministic-fallback set continues to cover `nemoclaw_runtime_*` failure reasons, so opt-in NemoClaw still degrades gracefully if `openclaw` is missing.

### Negative

- A `RALPH_DISPATCHER=nemoclaw` opt-in is now a "dormant" path. We must keep its tests green even though it is rarely exercised end-to-end on the operator's machine.
- A future operator who has `openclaw` installed and expects NemoClaw to be default must explicitly opt in.

### Neutral

- No change to `apply_allowed` / `commit_allowed` / `push_allowed` / `pr_allowed` / `merge_allowed` / `deploy_allowed` / `migration_allowed` semantics — all remain `false` at the dispatcher boundary regardless of which dispatcher is selected.
- No change to env scrubbing, secret redaction, requested_paths validation, or any other policy gate.
- No change to fullauto auto-approval semantics (PRs #50 / #51).

## Reversal criteria

If any of these become true, this ADR should be reopened:

1. `openclaw` becomes installable on the deploy host AND is verified end-to-end against the NemoClaw policy on at least a 10-story soak.
2. A second vendor's mediator (not NemoClaw) is implemented and exercised; we may then want a generic "mediated path" default with the operator picking among mediators.
3. The OpenCode + Kimi K2.6 dispatcher accumulates a serious safety regression (e.g. a leaked-secret, an unrequested-path patch, or a policy bypass) that NemoClaw mediation would have prevented.

Until then, the default is opencode-kimi-direct.

## References

- `src/ralph/opencode-kimi-dispatcher.js` (PR #45, #46)
- `src/ralph/autonomous-loop.js` `buildDefaultOpenCodeDispatcher`
- `src/ralph/nemoclaw-policy.js` (retained policy spec)
- `src/ralph/nemoclaw-opencode-gateway.js` (retained, now deprecated default)
- `docs/ralph-detailed-design-v0.2.md` §8 NemoClaw status, §9 Kimi-direct dispatcher
- `docs/soak-2026-05-14-summary.md` 19/19 clean patches under Kimi-direct
- PRs #45, #46, #47, #49, #50, #51, #52
