# Runbook: Restart the Soak Supplier Without Duplicating Story IDs

**Runbook ID**: `runbook-restart-stuck-supplier-000054-20260517072114`  
**Purpose**: Safely stop a stuck or misbehaving `scripts/ralph/soak-story-supplier.js` process and resume it so that story IDs and requested file paths are not duplicated.  
**Estimated Duration**: 2–5 minutes  
**Prerequisites**: `soak-harness.sh` is managing the supplier, or the supplier is running directly; write access to `.ralph/soak/`.  

---

## Step 1: Detect the Stuck Supplier

Confirm the supplier is stuck (e.g., no new stories in the queue, high CPU, or repeated `.ralph/logs/supplier.jsonl` errors).

```bash
scripts/ralph/soak-harness.sh status
```

**Expected Output**:
- `supplier: RUNNING` but dashboard shows no new `queued` stories for >10 minutes, **or**
- `supplier: EXITED EARLY`.

**Spot-check the log**:
```bash
tail -n 20 .ralph/logs/supplier.jsonl | jq -c '{event, story_id, reason}'
```

---

## Step 2: Stop the Supplier

Send a clean stop signal via the harness (preferred) so the process flushes its state.

```bash
scripts/ralph/soak-harness.sh stop
```

If you started the supplier manually without the harness, `Ctrl-C` (SIGINT) the process; `runSupplier()` traps `SIGINT`/`SIGTERM` and writes the final sequence state before exiting.

**Expected Output**:
```json
{"event":"supplier_stopped","emitted":<N>,"stopped_by_signal":true}
```

Wait until the status shows both processes stopped:
```bash
scripts/ralph/soak-harness.sh status
```

---

## Step 3: Verify Persisted Sequence Counter

Before resuming, read `.ralph/soak/supplier-state.json` to confirm the next sequence number is saved and non-zero.

```bash
cat .ralph/soak/supplier-state.json | jq '{seq, updated_at}'
```

**Expected Output**:
```json
{
  "seq": 42,
  "updated_at": "2026-05-17T07:20:00.000Z"
}
```

- If `seq` is absent or `0`, the supplier will start from the first template again. This is safe but may recreate previously used slugs, so note the previous `seq` from the log if needed.
- If the file is missing, the supplier defaults to `{ seq: 0 }` and will begin a fresh rotation.

---

## Step 4: Resume the Supplier

Restart the supplier with the same arguments used originally (e.g., same `--rate-per-hour`, `--mode`, and `--story-prefix`). The harness start command should preserve these via `.ralph/soak/harness.env`, or pass them explicitly:

```bash
scripts/ralph/soak-harness.sh start \
  --rate-per-hour 30 \
  --mode approval
```

If running directly:
```bash
node scripts/ralph/soak-story-supplier.js \
  --rate-per-hour 30 \
  --mode approval
```

**What prevents duplication**:
- The `seq` counter in `supplier-state.json` is loaded on startup and incremented atomically after each successful emission, so the new `STORY-...-<seq>` ID will be strictly higher than any prior one.
- Every story’s `requested_paths` contains a `run_stamp` baked in at process start (e.g. `docs/soak/runbook-restart-stuck-supplier-000054-20260517072114.md`). Even if the same template rotates again, the timestamped suffix ensures the file path is unique to this run.

---

## Step 5: Validate the First Restarted Story

Watch the supplier log to confirm the first emitted story has a higher sequence number than before and that creation succeeds.

```bash
scripts/ralph/soak-harness.sh tail supplier
```

Within one interval (e.g., 2 minutes for 30 stories/hour), you should see:
```json
{"event":"supplier_started","run_stamp":"20260517072114", ...}
{"event":"emit_ok","story_id":"STORY-SOAK-20260517072114-000042","seq":42,...}
```

Check that `seq` matches the value from Step 3 (or higher if another story was emitted since).

---

## Step 6: Confirm in the Dashboard

Finally, verify the new story appears in the queue and its requested path is not a duplicate of an already-completed story.

```bash
node scripts/ralph/dashboard.js --markdown | head -20
```

Look for:
- A new story with status `queued` and a unique `story_id`.
- The `requested_paths` field contains `docs/soak/<family>-<slug>-<seq>-<run_stamp>.md`, not a bare `.md` without a run stamp.

---

## Escalation

- If `supplier-state.json` is corrupted or shows `seq` lower than the highest `seq` in `.ralph/logs/supplier.jsonl`, back up the file and manually edit `seq` to the highest observed value plus one, then restart.
- If story creation fails with `nothing to commit` or `path already exists`, check whether an older soak run left tracked files at `docs/soak/*.md`; the `run_stamp` suffix should prevent this, but if a story was created without it, manually rename or remove the stale file before restarting.
