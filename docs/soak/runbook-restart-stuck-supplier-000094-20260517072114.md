# Runbook: Restart a Stuck Soak Story Supplier

Use this runbook to stop a running or hung `scripts/ralph/soak-story-supplier.js` and resume it later without resetting or duplicating story sequence IDs. The supplier persists its sequence counter in `.ralph/soak/supplier-state.json`; preserving that file (or reconstructing it from logs) is the only safeguard against duplicate `STORY-*` IDs.

**Runbook ID**: `runbook-restart-stuck-supplier-000094-20260517072114`  
**Purpose**: Stop and resume the soak story supplier without duplicating story IDs.  
**Estimated Duration**: 2–5 minutes  
**Prerequisites**: Supplier is running or was recently running; read access to `.ralph/soak/` and `.ralph/logs/`.

---

## Step 1: Inspect Current Supplier State

Before touching the process, capture the PID, the persisted sequence counter, and the last few log lines.

```bash
scripts/ralph/soak-harness.sh status
cat .ralph/soak/supplier-state.json 2>/dev/null || echo "STATE MISSING"
tail -n 5 .ralph/soak/supplier.log
```

**Expected Output**:
- `supplier: RUNNING (pid <N>)` (or `DEAD` if already stopped)
- `{"seq": <N>}` (or nothing if the state file is missing)
- The final log line should be either `"event":"emit_ok"` or `"event":"supplier_stopped"`.

**Decision Gate**:
- **State present and `seq > 0`** → Proceed to Step 2.
- **State missing, or `seq == 0` but the log shows prior emits** → The counter was reset; jump to Step 6 (recovery) before resuming.

---

## Step 2: Stop the Supplier Cleanly

Issue a graceful stop so the supplier has time to flush its final state and close the JSONL log.

```bash
# Option A — stop the entire harness (daemon + supplier)
scripts/ralph/soak-harness.sh stop

# Option B — stop only the supplier while keeping the daemon alive
kill -SIGINT "$(cat .ralph/soak/supplier.pid)"
sleep 3
scripts/ralph/soak-harness.sh status | grep supplier
```

**Expected Output**:
- `supplier: DEAD (last pid <N>, log .ralph/soak/supplier.log)`
- The last line of `.ralph/soak/supplier.log` should contain `"event":"supplier_stopped"`.

**Caution**: Avoid `kill -9` unless the process is unresponsive. A forced kill may skip the final state flush and leave `supplier-state.json` stale.

---

## Step 3: Verify supplier-state.json Is Intact

Confirm the persisted `seq` is strictly ahead of the highest sequence already emitted.

```bash
cat .ralph/soak/supplier-state.json

# Cross-check against the on-disk log
LAST_SEQ=$(grep '"event":"emit_ok"' .ralph/soak/supplier.log \
  | jq -s '[.[].seq] | max // -1')
STATE_SEQ=$(jq '.seq' .ralph/soak/supplier-state.json)

echo "last emitted seq: ${LAST_SEQ}; next seq in state: ${STATE_SEQ}"
[ "${STATE_SEQ}" -gt "${LAST_SEQ}" ] && echo "OK — no overlap" || echo "FAIL — collision risk"
```

**Expected Output**:
- `last emitted seq: 42; next seq in state: 43`
- `OK — no overlap`

**Decision Gate**:
- **OK** → Safe to resume (Step 4).
- **FAIL or state file missing** → Go to Step 6 to reconstruct the counter from logs before resuming.

---

## Step 4: Resume the Supplier

Restart with the same flags so the supplier loads the existing state file and continues from the preserved `seq`.

```bash
# Resume via the harness (recommended)
scripts/ralph/soak-harness.sh start \
  --rate-per-hour 30 \
  --mode approval \
  --supplier-max-stories 0

# Or resume the supplier standalone
node scripts/ralph/soak-story-supplier.js \
  --rate-per-hour 30 \
  --mode approval \
  --story-prefix SOAK
```

**Expected Output**:
- `supplier status: RUNNING`
- No immediate `emit_ok` lines with a `seq` lower than `STATE_SEQ` from Step 3.

---

## Step 5: Validate the First New Story

Wait one emission interval and confirm the resumed supplier is emitting fresh, non-duplicate IDs.

```bash
# At rate 30/hr the interval is 120 s; wait slightly longer
sleep 130

NEW_SEQ=$(grep '"event":"emit_ok"' .ralph/soak/supplier.log | tail -1 | jq '.seq')
echo "first new seq after resume: ${NEW_SEQ}"
```

**Expected Output**:
- `NEW_SEQ` equals the `STATE_SEQ` value recorded in Step 3 (e.g., `43`).

**Rollback**:
- If `NEW_SEQ` is **less than** `STATE_SEQ`, or the story ID already exists in the queue, stop immediately:
  ```bash
  scripts/ralph/soak-harness.sh stop
  ```
  Then run Step 6 before any further emits occur.

---

## Step 6: Recover from Missing or Corrupted State

If `.ralph/soak/supplier-state.json` is missing, empty, or contains a stale `seq`, reconstruct the next sequence number from the supplier JSONL log and seed a corrected state file.

```bash
# Find the highest seq that was successfully emitted
LAST_EMITTED=$(grep '"event":"emit_ok"' .ralph/soak/supplier.log \
  | jq -s '[.[].seq] | max // -1')

# The next seq must be one past the last emitted story
NEXT_SEQ=$((LAST_EMITTED + 1))

mkdir -p .ralph/soak
cat > .ralph/soak/supplier-state.json <<EOF
{
  "seq": ${NEXT_SEQ},
  "recovered_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "manual recovery after stuck supplier restart"
}
EOF

echo "Recovered state: next seq = ${NEXT_SEQ}"
```

**Validation**: Re-run the cross-check from Step 3 to confirm `STATE_SEQ > LAST_EMITTED`.

**Note**: If the log file is also missing, you must derive `NEXT_SEQ` from the story queue itself (e.g., `ralph stories list --labels soak | jq -r '.[].story_id' | grep SOAK | sort -t'-' -k5 -n | tail -1`) before resuming. Without any anchor, the safest option is to set `seq` to a value far ahead of all known soak stories.

---

## Escalation

- If `supplier-state.json` is corrupted and the log contains **no** `emit_ok` events, you cannot determine the next `seq`. Freeze the soak and page the **Ralph Platform** on-call.
- If duplicate story IDs are detected after resumption, immediately stop the supplier and open an incident ticket; do **not** bulk-delete stories until the root cause is recorded.
