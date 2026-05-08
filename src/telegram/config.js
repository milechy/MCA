const { SECRET_SCOPES } = require('../ralph/secrets-policy');
const { verifyRuntimeEnvInjection } = require('../ralph/runtime-env-preflight');

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
  const runtime_env_preflight = verifyRuntimeEnvInjection({
    target_env: 'local',
    scope: SECRET_SCOPES.LOCAL_ONLY,
    action: 'telegram_config_load',
    required_env_keys: ['TELEGRAM_BOT_TOKEN'],
    env
  });

  return {
    bot_token: runtime_env_preflight.ok ? env.TELEGRAM_BOT_TOKEN || null : null,
    allowed_user_ids: parseCsvNumberList(env.TELEGRAM_ALLOWED_USER_IDS),
    allowed_chat_ids: parseCsvNumberList(env.TELEGRAM_ALLOWED_CHAT_IDS),
    dry_run: env.TELEGRAM_DRY_RUN !== 'false',
    runtime_env_preflight
  };
}

module.exports = {
  parseCsvNumberList,
  loadTelegramConfig
};
