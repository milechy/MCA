const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { loadTelegramConfig } = require('./config');
const { processTelegramUpdate } = require('./bot');

function telegramOffsetPath(rootDir = process.cwd()) {
  return path.join(rootDir, '.ralph', 'telegram-offset.json');
}

function loadOffset(rootDir = process.cwd()) {
  const filePath = telegramOffsetPath(rootDir);
  if (!fs.existsSync(filePath)) return 0;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Number(parsed.offset || 0);
}

function saveOffset(offset, rootDir = process.cwd()) {
  const filePath = telegramOffsetPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ offset, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return offset;
}

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
  const env = options.env || process.env;
  const config = options.config || loadTelegramConfig(env);
  const result = await processTelegramUpdate(update, {
    config,
    rootDir: options.rootDir || process.cwd(),
    roles: options.roles,
    env
  });

  if (result.chat_id) {
    await sendMessage(config, result.chat_id, result.response_text);
  }

  return result;
}

async function runPolling(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const env = options.env || process.env;
  const config = options.config || loadTelegramConfig(env);
  if (!config.bot_token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  let offset = options.offset ?? loadOffset(rootDir);
  const maxIterations = options.maxIterations || Infinity;
  let iterations = 0;

  console.log(`[telegram-runtime] polling started dry_run=${config.dry_run} offset=${offset}`);

  while (iterations < maxIterations) {
    iterations += 1;
    const updates = await getUpdates(config, offset);

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update, {
        config,
        rootDir,
        roles: options.roles,
        env
      });
      saveOffset(offset, rootDir);
    }

    if (updates.length === 0) {
      saveOffset(offset, rootDir);
    }
  }

  return { ok: true, offset, iterations };
}

module.exports = {
  telegramOffsetPath,
  loadOffset,
  saveOffset,
  telegramApiRequest,
  getUpdates,
  sendMessage,
  handleUpdate,
  runPolling
};
