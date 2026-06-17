# Resume After Security Stop

The **resume-after-security-stop** workflow is initiated exclusively by an administration account and is strictly limited to a single invocation.

Once a security stop has been triggered, the workflow allows an admin to resume the affected process with explicit, one-time authorization. Because it is single-use, the same stop event cannot be resumed a second time without human validation.

This mechanism is deliberately non-automated: it must never run in fullauto mode, ensuring that a conscious administrator is always in the loop. The combination of admin-only access, single-use enforcement, and the prohibition on fullauto operation guarantees a controlled and auditable recovery.
