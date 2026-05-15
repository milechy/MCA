# ADR-2026-05-14: Promote OpenCode + Kimi K2.6 to Default Provider, Demote NemoClaw to Opt-In

## Status
Accepted

## Context
Ralph supports multiple execution providers. Historically, the default provider was NemoClaw. Recent soak testing and operational experience have shown that the OpenCode provider, backed by Kimi K2.6 via OpenRouter, delivers more reliable and higher-quality results for automated execution tasks.

## Decision
We will promote the **OpenCode + Kimi K2.6** provider combination to the **default** execution path.

Concurrently, we will **demote NemoClaw** from default to an **opt-in** provider. Users who still wish to use NemoClaw must explicitly select it via configuration.

## Consequences
- **Positive:** New and existing users will benefit from improved reliability and output quality by default without needing to change configuration.
- **Positive:** Reduced operational overhead from fewer default-path failures.
- **Negative:** Users implicitly relying on NemoClaw behavior may experience a change in output style or capabilities if they have not pinned their provider.
- **Mitigation:** NemoClaw remains fully available as an opt-in choice for users who require it.

## Related
- Soak test ID: `decision-kimi-default-000008`
