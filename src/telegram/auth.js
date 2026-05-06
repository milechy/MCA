function getTelegramUserId(update) {
  return update?.message?.from?.id || update?.callback_query?.from?.id || null;
}

function getTelegramChatId(update) {
  return update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || null;
}

function isAllowedTelegramUpdate(update, config) {
  const userId = getTelegramUserId(update);
  const chatId = getTelegramChatId(update);

  if (!userId || !chatId) {
    return { ok: false, reason: 'missing_user_or_chat_id', user_id: userId, chat_id: chatId };
  }

  if (!config.allowed_user_ids.includes(userId)) {
    return { ok: false, reason: 'telegram_user_not_allowed', user_id: userId, chat_id: chatId };
  }

  if (!config.allowed_chat_ids.includes(chatId)) {
    return { ok: false, reason: 'telegram_chat_not_allowed', user_id: userId, chat_id: chatId };
  }

  return { ok: true, user_id: userId, chat_id: chatId };
}

module.exports = {
  getTelegramUserId,
  getTelegramChatId,
  isAllowedTelegramUpdate
};
