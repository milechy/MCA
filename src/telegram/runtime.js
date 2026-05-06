const https = require('node:https');
const { loadTelegramConfig } = require('./config');
const { processTelegramUpdate } = require('./bot');

function telegramApiRequest(botToken, method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request({
      hostname: 'api.telegram.org',
      family: 4,
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram API ${method} failed: ${JSON.stringify(parsed)}`));
            return;
          }
          resolve(parsed.result);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Telegram API ${method} timed out`));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function getUpdates(config, offset) {
  return telegramApiRequest(config.bot_token, 'getUpdates', {
    offset,
    timeout: 20,
    allowed_updates: ['message', 'callback_query']
  });
}

async function sendMessage(config, chatId, text) {
  if (config.dry_run) {
    console.log(`[telegram-runtime] dry-run sendMessage chat=${chatId}\n${text}`);
    return { dry_run: true, chat_id: chatId, text };
  }

  return telegramApiRequest(config.bot_token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  });
}

async function handleUpdate(update, options = {}) {
  const config = options.config || loadTelegramConfig(options.env || process.env);
  const result = await processTelegramUpdate(update, {
    config,
    rootDir: options.rootDir || process.cwd(),
    roles: options.roles
  });

  if (result.chat_id) {
    await sendMessage(config, result.chat_id, result.response_text);
  }

  return result;
}

async function runPolling(options = {}) {
  const config = options.config || loadTelegramConfig(options.env || process.env);
  if (!config.bot_token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  let offset = options.offset || 0;
  const maxIterations = options.maxIterations || Infinity;
  let iterations = 0;

  console.log(`[telegram-runtime] polling started dry_run=${config.dry_run}`);

  while (iterations < maxIterations) {
    iterations += 1;
    const updates = await getUpdates(config, offset);

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update, {
        config,
        rootDir: options.rootDir || process.cwd(),
        roles: options.roles
      });
    }
  }

  return { ok: true, offset, iterations };
}

module.exports = {
  telegramApiRequest,
  getUpdates,
  sendMessage,
  handleUpdate,
  runPolling
};
