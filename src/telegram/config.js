function parseCsvNumberList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function loadTelegramConfig(env = process.env) {
  return {
    bot_token: env.TELEGRAM_BOT_TOKEN || null,
    allowed_user_ids: parseCsvNumberList(env.TELEGRAM_ALLOWED_USER_IDS),
    allowed_chat_ids: parseCsvNumberList(env.TELEGRAM_ALLOWED_CHAT_IDS),
    dry_run: env.TELEGRAM_DRY_RUN !== 'false'
  };
}

module.exports = {
  parseCsvNumberList,
  loadTelegramConfig
};
