# ADR: NemoClaw learning-router brain + NVIDIA LLM Router (complexity classifier) adoption

Status: accepted (2026-05-31)
Owner: Ralph autonomous-loop infrastructure
Phase: A (intelligent routing brain)
Supersedes (router role only): `adr-2026-05-14-retire-nemoclaw-mediator-default.md`

## Context

The Ralph loop executes issues→PRs end to end, but model choice was a **static,
learning-blind** difficulty ladder (`executor-router.js` `DIFFICULTY_TIER_MODELS`).
Investigation (external + on-host) found:

1. **OpenClaw/NemoClaw is a real, current stack and is already stood up here.**
   Sandbox `mca-ralph` runs **OpenClaw v2026.4.24** under NemoClaw/OpenShell
   (model gemini-2.5-flash, CPU). The 2026-05-14 ADR's "openclaw MISSING" was
   about a *host* binary; OpenClaw actually runs *inside* the sandbox. (Gateway
   is currently down — Docker `openshell-cluster-nemoclaw` not running.)
2. **NemoClaw's "routed inference" ≠ capability routing.** It is *privacy
   routing* (sensitive→local Nemotron / else→cloud) over a single configured
   model. It does NOT pick "the best LLM for this function" by capability/cost.
3. **That intelligent layer is the NVIDIA LLM Router's job.** Its brain is
   `nvidia/prompt-task-and-complexity-classifier` (DeBERTa-v3-base, 0.2B): 11
   task types (incl. Code Generation) + a 0-1 complexity score.
4. **The learning loop was open at both ends.** `recordTaskOutcome()` was never
   called by the live loop, and `executor-router` never read `routing-stats`.
   Static difficulty was frequently mispredicted (outcomes.jsonl: predicted
   easy / actual hard).

## Decision

Introduce a **NemoClaw routing brain** (`src/ralph/nemoclaw-brain.js`) that
selects the executor model by combining, in precedence order:

1. `story.executor_model` — operator override (allowlist still applies)
2. **escalation ladder** on retry — `kimi-k2.6 → haiku-4.5 → sonnet-4.6 → gpt-5`,
   climbing one rung per non-transient failure; transient failures
   (`provider_rate_limited` …) retry the same tier with backoff
3. **learned recommendation** — `routing-stats.recommendByContextBucket`
   (success-rate × cost-per-success) when a context bucket has confident samples
4. **classifier / difficulty tier** — NVIDIA `complexity_router` policy: the
   classifier's `prompt_complexity_score` → tier (preferred over the often-wrong
   static `story.difficulty`); difficulty is the fallback prior

plus a **per-story cost cap** (`RALPH_STORY_COST_CAP_USD`, default $0.50) that
flips `escalate_to_human` so the loop never silently overspends; combined with
the Phase 16 hard test gate, it never merges red. This is the "pick the best
LLM for the function, and keep climbing until tests pass or a human is needed"
guarantee.

The learning loop is closed at the data end by recording each routing decision
to `.ralph/brain-decisions.jsonl`, and (next) by wiring `recordTaskOutcome()`
into the live loop's terminal phases.

### NVIDIA LLM Router adoption — CPU adaptation

This host is Apple Silicon (no NVIDIA GPU), so the full LLM Router Blueprint
(Triton/NIM/Docker Compose, GPU-required) is not deployed. Instead we adopt the
blueprint's **brain** — the trained `prompt-task-and-complexity-classifier` —
and run it directly on CPU via `scripts/ralph/complexity-classifier/classify.py`.
Verified: weights load cleanly (`missing=0 unexpected=0`), sane outputs
("typo fix"→Text Generation/0.16, "Implement Queue with tests"→Code
Generation/0.95-prob), warm latency ~110 ms/CPU. A zero-dependency `heuristic`
backend is the documented fallback so the loop never blocks on the ML runtime.

### Execution path — staged migration

Model *selection* (this ADR) is decoupled from model *execution*. Execution
stays on the proven `opencode-kimi` dispatcher for now; reviving the
NemoClaw/OpenClaw sandbox as a shadow execution backend, then migrating once it
matches on green-rate and cost, is Phase B/C.

## Consequences

- `executor-router.routeExecutor()` consults the brain only when it has a richer
  signal (classifier reading, prior outcomes, or a retry); plain first-attempt
  calls keep the exact legacy static contract — backward compatible, brain on by
  default (`RALPH_BRAIN=off` to disable).
- The NVIDIA classifier's complexity is creativity-weighted, so it rates code
  tasks low → cost-first routing to Kimi, with the escalation ladder doing the
  heavy lifting on failure. Tuning the code-aware tier mapping is a follow-up.
- Per-call classifier cost is a full model load (~6 s) via `spawnSync`; a
  persistent classifier server is a Phase B optimization.
- New deps live in an isolated venv (gitignored); HF model cache (~700 MB) is
  not committed.

## Alternatives rejected
- Hand-rolled learning router only (reinvents NVIDIA's classifier).
- Full GPU LLM Router stack (no NVIDIA GPU on host).
- OpenRouter `auto` as the executor (kept only as a future exploration signal).
