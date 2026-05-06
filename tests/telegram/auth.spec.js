const { test, expect } = require('@playwright/test');
const { loadTelegramConfig } = require('../../src/telegram/config');
const { isAllowedTelegramUpdate } = require('../../src/telegram/auth');

function update(userId, chatId, text = '/ping') {
  return {
    message: {
      text,
      from: { id: userId },
      chat: { id: chatId }
    }
  };
}

test('loads allowlists from environment', () => {
  const config = loadTelegramConfig({
    TELEGRAM_ALLOWED_USER_IDS: '1,2,3',
    TELEGRAM_ALLOWED_CHAT_IDS: '10,20'
  });

  expect(config.allowed_user_ids).toEqual([1, 2, 3]);
  expect(config.allowed_chat_ids).toEqual([10, 20]);
  expect(config.dry_run).toBe(true);
});

test('allows only configured user and chat ids', () => {
  const config = {
    allowed_user_ids: [1],
    allowed_chat_ids: [10]
  };

  expect(isAllowedTelegramUpdate(update(1, 10), config).ok).toBe(true);
  expect(isAllowedTelegramUpdate(update(2, 10), config).reason).toBe('telegram_user_not_allowed');
  expect(isAllowedTelegramUpdate(update(1, 99), config).reason).toBe('telegram_chat_not_allowed');
});
