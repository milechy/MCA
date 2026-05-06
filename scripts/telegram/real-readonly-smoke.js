#!/usr/bin/env node

const { handleUpdate } = require('../../src/telegram/runtime');
const { realTransportGuard, READ_ONLY_COMMANDS } = require('./real-transport-guard');

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function assertReadOnlyCommands(commands) {
  const disallowed = commands.filter((command) => !READ_ONLY_COMMANDS.includes(command));
  if (disallowed.length > 0) {
    throw new Error(`real_readonly_smoke_disallowed_commands:${disallowed.join(',')}`);
  }
}

function makeUpdate(command, { userId, chatId, updateId }) {
  return {
    update_id: updateId,
    message: {
      text: command,
      from: { id: userId },
      chat: { id: chatId }
    }
  };
}

async function runRealReadOnlySmoke({
  rootDir = process.cwd(),
  env = process.env,
  commands = READ_ONLY_COMMANDS,
  dryRunTelegramSend = false
} = {}) {
  assertReadOnlyCommands(commands);

  const guard = realTransportGuard({ rootDir, env, includeGitDiff: true });
  if (!guard.ok) {
    return {
      ok: false,
      reason: 'real_transport_guard_failed',
      guard,
      results: []
    };
  }

  const userIds = parseList(env.TELEGRAM_ALLOWED_USER_IDS);
  const chatIds = parseList(env.TELEGRAM_ALLOWED_CHAT_IDS);
  const userId = userIds[0];
  const chatId = chatIds[0];

  if (!Number.isFinite(userId) || !Number.isFinite(chatId)) {
    return {
      ok: false,
      reason: 'telegram_ids_parse_failed',
      guard,
      results: []
    };
  }

  const config = {
    dry_run: dryRunTelegramSend,
    bot_token: env.TELEGRAM_BOT_TOKEN,
    allowed_user_ids: userIds,
    allowed_chat_ids: chatIds
  };

  const roles = {
    owner_user_ids: [],
    admin_user_ids: [],
    reviewer_user_ids: userIds,
    observer_user_ids: []
  };

  const results = [];
  let updateId = Date.now();
  for (const command of commands) {
    const response = await handleUpdate(makeUpdate(command, { userId, chatId, updateId: updateId++ }), {
      rootDir,
      config,
      roles,
      env: { ...env, RALPH_TELEGRAM_RUN_ALL_ENABLED: '' }
    });

    results.push({
      command,
      ok: response.ok,
      reason: response.reason || null,
      response_text: response.response_text || null
    });
  }

  return {
    ok: results.every((result) => result.ok === true),
    reason: results.every((result) => result.ok === true) ? null : 'real_readonly_smoke_failed',
    guard: {
      ok: guard.ok,
      stage: guard.stage,
      allowed_commands: guard.allowed_commands,
      forbidden_commands: guard.forbidden_commands,
      run_all_enabled: guard.run_all_enabled,
      telegram_env_ok: guard.telegram_env_ok,
      token_redacted: guard.token_redacted,
      repo_secret_preflight_ok: guard.repo_secret_preflight_ok
    },
    dry_run_telegram_send: dryRunTelegramSend,
    commands,
    results
  };
}

async function main() {
  const result = await runRealReadOnlySmoke({ rootDir: process.cwd(), env: process.env, dryRunTelegramSend: false });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseList,
  assertReadOnlyCommands,
  makeUpdate,
  runRealReadOnlySmoke
};
