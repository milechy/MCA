# Runbook: Restart a Stuck Soak Story Supplier

Use this runbook when `scripts/ralph/soak-story-supplier.js` becomes stuck or unresponsive and must be stopped and resumed without emitting duplicate story IDs.

## 1. Detect the stuck supplier

Confirm the supplier is not making forward progress. In one terminal:

```bash
scripts/ralph/soak-harness.sh status
```

Look for `supplier: RUNNING` with a stale uptime, or `supplier: EXITED EARLY`. In another terminal, check the tail of the supplier log for repeating errors or silence:

```bash
tail -40 .ralph/logs/supplier.jsonl
```

If the last `supplier_story_created` event is older than `2 × interval_ms` (e.g., 6 minutes at 30 stories/hour), the supplier is stuck.

## 2. Stop the supplier cleanly

Send a graceful shutdown signal. The supplier traps SIGINT/SIGTERM and flushes its sequence counter to disk before exiting.

```bash
scripts/ralph/soak-harness.sh stop
```

If the harness wrapper is unavailable, target the supplier process directly:

```bash
kill -TERM <supplier_pid>
```

Wait up to 10 seconds, then verify the process is gone:

```bash
scripts/ralph/soak-harness.sh status   # should show supplier: STOPPED
```

**Do not use `kill -9` (SIGKILL).** A hard kill may leave the state file unwritten and risk a duplicated sequence on restart.

## 3. Verify the persisted sequence state

Inspect `.ralph/soak/supplier-state.json` to confirm the sequence counter was saved:

```bash
cat .ralph/soak/supplier-state.json
```

**Expected shape**:
```json
{
  "seq": 42,
  "updated_at": "2026-05-17T07:20:14.000Z"
}
```

The `seq` value should match the last `supplier_story_created` line in `.ralph/logs/supplier.jsonl` (the log line shows `seq` as `emitted_so_far - 1`).

If the state file is missing or `seq` is lower than the log indicates, the previous shutdown was unclean. Proceed to **Step 5 (Recover from corrupted state)** before restarting.

## 4. Restart the supplier with identical parameters

Resume using the same prefix, rate, and mode so the new stories continue the prior run's numbering space. The supplier automatically reads `seq` from the state file and continues.

Via the harness:

```bash
scripts/ralph/soak-harness.sh start \
  --rate-per-hour 30 \
  --mode approval \
  --story-prefix SOAK
```

Or run the supplier standalone:

```bash
node scripts/ralph/soak-story-supplier.js \
  --rate-per-hour 30 \
  --mode approval \
  --story-prefix SOAK
```

**Do not pass `--max-stories` on a resume** unless you intend to cap the total run length; the supplier counts from the resumed `seq`, not from zero.

## 5. Confirm no duplicate story IDs

Within the first two intervals, check that the resumed supplier emitted a new story with a higher `seq` and a fresh `run_stamp`:

```bash
tail -5 .ralph/logs/supplier.jsonl
```

You should see:
- A `supplier_started` event with a new `run_stamp`
- An `emit_ok` line where `seq` is exactly one greater than the `seq` saved in the state file
- The `story_id` contains a new timestamp segment and the incremented sequence number

If `seq` restarted at `0` or the `story_id` collides with an earlier ID, stop the supplier immediately (`Ctrl+C` or `kill -TERM`) and investigate `.ralph/soak/supplier-state.json` for corruption.

## 6. Recover from corrupted state (optional)

If the state file is missing or `seq` is clearly wrong, reconstruct the correct sequence from the log and seed the state file manually.

```bash
# Find the highest seq that was successfully created
LAST_SEQ=$(grep '"event":"supplier_story_created"' .ralph/logs/supplier.jsonl | jq -s 'max_by(.seq) | .seq')

# Write it back
echo '{"seq":'"$((LAST_SEQ + 1))"'}' > .ralph/soak/supplier-state.json
```

Then return to **Step 4** and restart. The `+ 1` ensures the next story does not repeat the last successfully created ID.
