# Runbook: Restart Stuck soak-story-supplier Without Duplicating Story IDs

## Steps

1. **Stop the stuck supplier**
   - Find the process: `pgrep -f soak-story-supplier.js`
   - If found, terminate gracefully first: `kill <PID>`
   - Wait 10 seconds; if still running, force kill: `kill -9 <PID>`

2. **Identify the last supplied story ID**
   - Open `scripts/ralph/.soak-supplier-state.json` (or equivalent state file)
   - Record the value of `lastStoryId` and `lastTimestamp`
   - Save these values to a temporary scratch note for reference during restart

3. **Verify no duplicate risk from in-flight writes**
   - Check the process is fully gone: `pgrep -f soak-story-supplier.js` should return nothing
   - Inspect the latest lines of `logs/soak-story-supplier.log` to confirm the last emitted story ID matches the state file

4. **Resume the supplier from the correct offset**
   - Ensure `scripts/ralph/.soak-supplier-state.json` contains the confirmed `lastStoryId`
   - Restart the script: `node scripts/ralph/soak-story-supplier.js`
   - The script reads `.soak-supplier-state.json` on boot and resumes after `lastStoryId`

5. **Validate no duplicates are produced**
   - Within the first 60 seconds, tail the log: `tail -f logs/soak-story-supplier.log`
   - Confirm the first new story ID is strictly greater than the recorded `lastStoryId`
   - If not, stop the process immediately and investigate the state file

6. **Confirm health and close the runbook**
   - Check that the process stays up for at least 5 minutes without error loops
   - Verify `lastStoryId` in `.soak-supplier-state.json` is advancing periodically
   - Archive any temporary scratch notes and mark the incident as resolved
