function parseTelegramCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) {
    return { type: 'unknown', raw, args: [] };
  }

  const [commandWithBot, ...args] = raw.split(/\s+/);
  const command = commandWithBot.split('@')[0].toLowerCase();

  if (command === '/ping') return { type: 'ping', raw, args };
  if (command === '/status') return { type: 'status', raw, args };
  if (command === '/policy') return { type: 'policy', raw, args };
  if (command === '/confirm') return { type: 'confirm', raw, args };
  if (command === '/approvals') return { type: 'approvals', raw, args };
  if (command === '/approval') return { type: 'approval_detail', raw, args };
  if (command === '/execute-noop') return { type: 'execute_noop', raw, args };
  if (command === '/run-all') return { type: 'run_all', raw, args };
  if (command === '/opencode-plan') return { type: 'opencode_plan', raw, args };
  if (command === '/opencode-sandbox-plan') return { type: 'opencode_sandbox_plan', raw, args };
  if (command === '/opencode-sandbox-preflight') return { type: 'opencode_sandbox_preflight', raw, args };
  if (command === '/opencode-run') return { type: 'opencode_run', raw, args };
  if (command === '/opencode-patch-preview') return { type: 'opencode_patch_preview', raw, args };
  if (command === '/opencode-patch-approval') return { type: 'opencode_patch_approval', raw, args };
  if (command === '/opencode-apply-preflight') return { type: 'opencode_apply_preflight', raw, args };
  if (command === '/opencode-apply') return { type: 'opencode_apply', raw, args };

  if (command === '/mode') {
    const [modeAction, ...modeArgs] = args;
    if (modeAction === 'approval') return { type: 'mode_approval', raw, args: modeArgs };
    if (modeAction === 'fullauto') return { type: 'mode_fullauto_request', raw, args: modeArgs };
    return { type: 'mode_unknown', raw, args };
  }

  if (command === '/approve') return { type: 'approve', raw, args };
  if (command === '/deny') return { type: 'deny', raw, args };
  if (command === '/modify') return { type: 'modify', raw, args };

  return { type: 'unknown', raw, args };
}

module.exports = {
  parseTelegramCommand
};
