function evaluateShellExecutionPolicy(commandPreflight, options = {}) {
  if (!commandPreflight || commandPreflight.ok !== true) {
    return {
      ok: false,
      reason: 'command_preflight_required',
      command_preflight: commandPreflight || null
    };
  }

  const allowlistEntry = commandPreflight.allowlist_entry;
  if (!allowlistEntry) {
    return {
      ok: false,
      reason: 'allowlist_entry_required',
      command_preflight: commandPreflight
    };
  }

  if (allowlistEntry.dry_run_only === true) {
    return {
      ok: false,
      reason: 'allowlist_entry_is_dry_run_only',
      command_preflight: commandPreflight,
      allowlist_entry: allowlistEntry
    };
  }

  if (options.allow_real_execution !== true) {
    return {
      ok: false,
      reason: 'real_shell_execution_not_enabled',
      command_preflight: commandPreflight,
      allowlist_entry: allowlistEntry
    };
  }

  return {
    ok: true,
    reason: 'real_shell_execution_allowed_by_policy',
    command_preflight: commandPreflight,
    allowlist_entry: allowlistEntry,
    command_hash: commandPreflight.command_hash,
    timeout_ms: options.timeout_ms || 120_000
  };
}

module.exports = {
  evaluateShellExecutionPolicy
};
