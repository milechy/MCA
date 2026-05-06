const crypto = require('node:crypto');
const path = require('node:path');

const COMMAND_ALLOWLIST = [
  {
    id: 'gates-run-all',
    command: 'scripts/gates/run-all.sh',
    allowed_args: [],
    allowed_cwd: '.',
    phase: '3.9',
    dry_run_only: false
  }
];

function normalizeRelativePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function commandHash(commandRequest) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    command: commandRequest.command,
    args: commandRequest.args || [],
    cwd: commandRequest.cwd || '.'
  })).digest('hex')}`;
}

function activeAllowlist(options = {}) {
  return Array.isArray(options.allowlist) ? options.allowlist : COMMAND_ALLOWLIST;
}

function findAllowlistEntry(command, options = {}) {
  const normalized = normalizeRelativePath(command);
  return activeAllowlist(options).find((entry) => normalizeRelativePath(entry.command) === normalized) || null;
}

function validateCommandRequest(commandRequest, options = {}) {
  const request = {
    command: normalizeRelativePath(commandRequest.command),
    args: commandRequest.args || [],
    cwd: commandRequest.cwd || '.'
  };

  if (path.isAbsolute(request.command) || request.command.includes('..')) {
    return { ok: false, reason: 'command_path_not_allowed', request };
  }

  if (path.isAbsolute(request.cwd) || normalizeRelativePath(request.cwd).includes('..')) {
    return { ok: false, reason: 'cwd_not_allowed', request };
  }

  const entry = findAllowlistEntry(request.command, options);
  if (!entry) {
    return { ok: false, reason: 'command_not_allowlisted', request };
  }

  const requestedArgs = request.args.map(String);
  const allowedArgs = entry.allowed_args || [];
  const extraArgs = requestedArgs.filter((arg) => !allowedArgs.includes(arg));
  if (extraArgs.length > 0) {
    return { ok: false, reason: 'command_args_not_allowed', request, extra_args: extraArgs, allowlist_entry: entry };
  }

  const requestedCwd = normalizeRelativePath(request.cwd || '.');
  const allowedCwd = normalizeRelativePath(entry.allowed_cwd || '.');
  if (requestedCwd !== allowedCwd) {
    return { ok: false, reason: 'command_cwd_not_allowed', request, allowlist_entry: entry };
  }

  return {
    ok: true,
    request,
    allowlist_entry: entry,
    command_hash: commandHash(request),
    dry_run_only: entry.dry_run_only === true || options.dry_run_only === true
  };
}

module.exports = {
  COMMAND_ALLOWLIST,
  activeAllowlist,
  commandHash,
  findAllowlistEntry,
  normalizeRelativePath,
  validateCommandRequest
};
