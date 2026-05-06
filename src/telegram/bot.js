const { loadTelegramConfig } = require('./config');
const { isAllowedTelegramUpdate, getTelegramChatId } = require('./auth');
const { parseTelegramCommand } = require('./command-parser');
const { handleTelegramCommand } = require('./handlers');

function extractMessageText(update) {
  return update?.message?.text || update?.callback_query?.data || '';
}

async function processTelegramUpdate(update, options = {}) {
  const config = options.config || loadTelegramConfig(options.env || process.env);
  const auth = isAllowedTelegramUpdate(update, config);

  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason,
      chat_id: auth.chat_id || getTelegramChatId(update),
      response_text: 'Unauthorized Telegram command.'
    };
  }

  const parsed = parseTelegramCommand(extractMessageText(update));
  const response = handleTelegramCommand(parsed, {
    rootDir: options.rootDir || process.cwd(),
    user_id: auth.user_id,
    chat_id: auth.chat_id,
    roles: options.roles
  });

  return {
    ok: true,
    chat_id: auth.chat_id,
    parsed,
    response_text: response.text,
    response
  };
}

module.exports = {
  extractMessageText,
  processTelegramUpdate
};
