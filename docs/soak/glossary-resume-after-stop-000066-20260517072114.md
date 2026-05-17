# resume-after-security-stop workflow

If an active security stop is in effect, only an admin may trigger a **resume-after-security-stop** workflow. This workflow is strictly single-use; once it is invoked to clear a security stop, that exact workflow token is consumed and invalidated. It must never be attached to any fully automated ("fullauto") pipeline or recurring job. Manual admin approval is required each time the system needs to resume after a security stop, ensuring human oversight of the recovery decision.
