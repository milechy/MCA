# Phase 2 #5.x Budget Guard

The budget guard monitors daily Kimi API spend via `kimi-cost-tracker`.
If spend exceeds `RALPH_KIMI_DAILY_BUDGET_USD`, the daemon pauses new requests.
It resumes automatically once the spend drops back under the configured cap.
The default limit is `DEFAULT_DAILY_BUDGET_USD = 5.00`.
This guard never crashes the daemon; it only throttles execution safely.
