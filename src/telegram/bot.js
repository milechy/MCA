const { loadTelegramConfig } = require('./config');
const { isAllowedTelegramUpdate, getTelegramChatId } = require('./auth');
const { parseTelegramCommand } = require('./command-parser');
const { handleTelegramCommand } = require('./handlers');
const { isAutonomousCommand, handleAutonomousCommand } = require('./autonomous-command');
const { auditTelegramCommand } = require('./audit');

function extractMessageText(update) {
  return update?.message?.text || update?.callback_query?.data || '';
}

async function processTelegramUpdate(update, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const env = options.env || process.env;
  const config = options.config || loadTelegramConfig(env);
  const auth = isAllowedTelegramUpdate(update, config);

  if (!auth.ok) {
    auditTelegramCommand({
      command_type: 'unauthorized',
      user_id: auth.user_id || null,
      chat_id: auth.chat_id || getTelegramChatId(update),
      ok: false,
      reason: auth.reason,
      execution_connected: false
    }, { rootDir });

    return {
      ok: false,
      reason: auth.reason,
      chat_id: auth.chat_id || getTelegramChatId(update),
      response_text: 'Unauthorized Telegram command.'
    };
  }

  const parsed = parseTelegramCommand(extractMessageText(update));
  const handlerContext = {
    rootDir,
    user_id: auth.user_id,
    chat_id: auth.chat_id,
    roles: options.roles,
    env,
    now: options.now,
    requested_paths: options.requested_paths,
    mode: options.mode,
    target_env: options.target_env
  };
  const response = isAutonomousCommand(parsed.type)
    ? handleAutonomousCommand(parsed, handlerContext)
    : handleTelegramCommand(parsed, handlerContext);

  auditTelegramCommand({
    command_type: parsed.type,
    user_id: auth.user_id,
    chat_id: auth.chat_id,
    ok: response.ok,
    reason: response.result?.reason || response.summary?.reason || null,
    execution_connected: response.wired_to_runtime === true,
    summary: response.summary || null
  }, { rootDir });

  return {
    ok: true,
    chat_id: auth.chat_id,
    parsed,
    response_text: response.text,
    response
  };
}

module.exports = { extractMessageText, processTelegramUpdate };
