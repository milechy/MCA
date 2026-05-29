const { test, expect } = require('@playwright/test');

const {
  shouldNotify,
  buildSendMessage,
  notify,
  fmt
} = require('../../src/ralph/telegram-notify');

test('shouldNotify requires both token and chat id', () => {
  expect(shouldNotify({})).toBe(false);
  expect(shouldNotify({ TELEGRAM_BOT_TOKEN: 't' })).toBe(false);
  expect(shouldNotify({ TELEGRAM_CHAT_ID: 'c' })).toBe(false);
  expect(shouldNotify({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' })).toBe(true);
});

test('buildSendMessage builds url + urlencoded body', () => {
  const r = buildSendMessage({ token: 'TOK', chatId: '123', text: 'hello world' });
  expect(r.ok).toBe(true);
  expect(r.url).toBe('https://api.telegram.org/botTOK/sendMessage');
  expect(r.body).toContain('chat_id=123');
  expect(r.body).toContain('text=hello+world');
  expect(r.body).toContain('parse_mode=Markdown');
  expect(r.body).toContain('disable_web_page_preview=true');
});

test('buildSendMessage rejects missing fields', () => {
  expect(buildSendMessage({ token: 't', chatId: 'c' }).ok).toBe(false);
  expect(buildSendMessage({ text: 'x' }).ok).toBe(false);
});

test('buildSendMessage omits parse_mode when null', () => {
  const r = buildSendMessage({ token: 'T', chatId: '1', text: 'x', parseMode: null });
  expect(r.body).not.toContain('parse_mode');
});

test('notify is a clean no-op when unconfigured', async () => {
  const r = await notify({ env: {}, text: 'hi' });
  expect(r.skipped).toBe(true);
  expect(r.reason).toBe('telegram_not_configured');
});

test('notify posts when configured (injected fetch)', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const r = await notify({
    env: { TELEGRAM_BOT_TOKEN: 'TOK', TELEGRAM_CHAT_ID: '42' },
    text: 'deploy done',
    fetchImpl
  });
  expect(r.ok).toBe(true);
  expect(captured.url).toContain('/botTOK/sendMessage');
  expect(captured.opts.body).toContain('chat_id=42');
});

test('notify retries as plain text when Markdown parse fails', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // first (Markdown) fails, second (plain) succeeds
    return { json: async () => (calls === 1 ? { ok: false, description: "can't parse entities" } : { ok: true }) };
  };
  const r = await notify({
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' },
    text: 'model openrouter/foo_bar',
    fetchImpl
  });
  expect(calls).toBe(2);
  expect(r.ok).toBe(true);
  expect(r.markdown_fallback).toBe(true);
});

test('notify never throws on transport error', async () => {
  const r = await notify({
    env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' },
    text: 'x',
    fetchImpl: async () => { throw new Error('network down'); }
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('send_failed');
});

test('fmt produces readable messages for each event', () => {
  expect(fmt.prMerged({ issue: 246, pr: 247, model: 'haiku', cost: '0.08' })).toMatch(/Auto-merged.*#247.*#246/s);
  expect(fmt.costCeiling({ kind: 'daily', value: '$5.1', cap: '$5' })).toMatch(/Cost ceiling/);
  expect(fmt.backlogExhausted()).toMatch(/exhausted/);
  expect(fmt.supplierFiled({ issueTitle: '[BL-002] add once', url: 'http://x' })).toMatch(/BL-002/);
  expect(fmt.noDiff({ issue: 5 })).toMatch(/no diff/);
});
