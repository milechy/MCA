const { test, expect } = require('@playwright/test');

// The Worker lib is ESM (it ships to Cloudflare). Import it dynamically.
let lib;
test.beforeAll(async () => {
  lib = await import('../../telegram-worker/lib.mjs');
});

test('isAuthorized requires matching webhook secret', () => {
  const r = lib.isAuthorized({ headerSecret: 'wrong', expectedSecret: 'S', chatId: '1', allowedChatId: '1' });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('bad_webhook_secret');
});

test('isAuthorized requires allowed chat id (supports comma list)', () => {
  const base = { headerSecret: 'S', expectedSecret: 'S' };
  expect(lib.isAuthorized({ ...base, chatId: '99', allowedChatId: '1,2,3' }).ok).toBe(false);
  expect(lib.isAuthorized({ ...base, chatId: '2', allowedChatId: '1,2,3' }).ok).toBe(true);
});

test('isAuthorized allows any chat when allowedChatId is empty', () => {
  expect(lib.isAuthorized({ headerSecret: 'S', expectedSecret: 'S', chatId: '7', allowedChatId: '' }).ok).toBe(true);
});

test('parseUpdate extracts text + chat id', () => {
  const r = lib.parseUpdate({ message: { text: '  build a thing  ', chat: { id: 42 }, from: { username: 'h' } } });
  expect(r.ok).toBe(true);
  expect(r.text).toBe('build a thing');
  expect(r.chatId).toBe(42);
  expect(r.from).toBe('h');
});

test('parseUpdate rejects empty / missing message', () => {
  expect(lib.parseUpdate({}).reason).toBe('no_message');
  expect(lib.parseUpdate({ message: { text: '   ', chat: { id: 1 } } }).reason).toBe('empty_text');
});

test('classifyIntent recognizes control phrases vs develop', () => {
  expect(lib.classifyIntent('status').intent).toBe('status');
  expect(lib.classifyIntent('ヘルプ').intent).toBe('help');
  expect(lib.classifyIntent('止めて').intent).toBe('stop');
  expect(lib.classifyIntent('add a debounce helper').intent).toBe('develop');
});

test('buildOpenRouterRequest builds a chat-completions call', () => {
  const r = lib.buildOpenRouterRequest({ apiKey: 'K', userText: 'make X' });
  expect(r.ok).toBe(true);
  expect(r.url).toContain('openrouter.ai');
  const body = JSON.parse(r.init.body);
  expect(body.model).toContain('haiku');
  expect(body.messages[0].role).toBe('system');
  expect(body.messages[1].content).toBe('make X');
  expect(r.init.headers.Authorization).toBe('Bearer K');
});

test('buildOpenRouterRequest rejects missing inputs', () => {
  expect(lib.buildOpenRouterRequest({ apiKey: 'K' }).ok).toBe(false);
  expect(lib.buildOpenRouterRequest({ userText: 'x' }).ok).toBe(false);
});

test('extractIssueJson parses plain, fenced, and prose-wrapped JSON', () => {
  const plain = lib.extractIssueJson('{"title":"T","body":"B","feasible":true}');
  expect(plain.title).toBe('T');
  const fenced = lib.extractIssueJson('```json\n{"title":"T2","body":"B2"}\n```');
  expect(fenced.title).toBe('T2');
  expect(fenced.feasible).toBe(true); // defaults true
  const prose = lib.extractIssueJson('Sure! Here:\n{"title":"T3","body":"B3","feasible":false,"reason":"too big"}\nhope that helps');
  expect(prose.title).toBe('T3');
  expect(prose.feasible).toBe(false);
  expect(prose.reason).toBe('too big');
});

test('extractIssueJson returns null on garbage / missing fields', () => {
  expect(lib.extractIssueJson('no json here')).toBe(null);
  expect(lib.extractIssueJson('{"title":"only title"}')).toBe(null);
  expect(lib.extractIssueJson('')).toBe(null);
});

test('buildGithubIssueRequest builds an authenticated create-issue call', () => {
  const r = lib.buildGithubIssueRequest({ token: 'PAT', repo: 'o/r', title: 'T', body: 'B' });
  expect(r.ok).toBe(true);
  expect(r.url).toBe('https://api.github.com/repos/o/r/issues');
  const body = JSON.parse(r.init.body);
  expect(body.labels).toEqual(['aider-fix']);
  expect(r.init.headers.Authorization).toBe('Bearer PAT');
});

test('buildGithubIssueRequest rejects missing fields', () => {
  expect(lib.buildGithubIssueRequest({ token: 'P', repo: 'o/r', title: 'T' }).ok).toBe(false);
});

test('buildTelegramReply builds a sendMessage form post', () => {
  const r = lib.buildTelegramReply({ token: 'TOK', chatId: 5, text: 'done' });
  expect(r.ok).toBe(true);
  expect(r.url).toContain('/botTOK/sendMessage');
  expect(r.init.body).toContain('chat_id=5');
  expect(r.init.body).toContain('text=done');
});

// ---- multi-project routing (Option B) ----------------------------------

test('parseUpdate captures the forum topic thread id', () => {
  const r = lib.parseUpdate({ message: { text: 'hi', chat: { id: 9 }, message_thread_id: 42 } });
  expect(r.chatId).toBe(9);
  expect(r.threadId).toBe(42);
  const noTopic = lib.parseUpdate({ message: { text: 'hi', chat: { id: 9 } } });
  expect(noTopic.threadId).toBe(null);
});

test('routeKey combines chat + thread (null thread → :0)', () => {
  expect(lib.routeKey(9, 42)).toBe('9:42');
  expect(lib.routeKey(9, null)).toBe('9:0');
});

test('repoAllowed validates owner/name and honors an allowlist', () => {
  expect(lib.repoAllowed('milechy/MCA')).toBe(true);
  expect(lib.repoAllowed('not-a-repo')).toBe(false);
  expect(lib.repoAllowed('a/b', 'a/b,c/d')).toBe(true);
  expect(lib.repoAllowed('x/y', 'a/b,c/d')).toBe(false);
});

test('parseProjectCommand parses set/show/clear (and non-commands)', () => {
  expect(lib.parseProjectCommand('/project milechy/MCA')).toEqual({ action: 'set', repo: 'milechy/MCA' });
  expect(lib.parseProjectCommand('/proj a/b')).toEqual({ action: 'set', repo: 'a/b' });
  expect(lib.parseProjectCommand('/project')).toEqual({ action: 'show' });
  expect(lib.parseProjectCommand('/project clear')).toEqual({ action: 'clear' });
  expect(lib.parseProjectCommand('add a util')).toBe(null);
});

test('parseProjectCommand strips a github URL to owner/repo', () => {
  expect(lib.parseProjectCommand('/project https://github.com/milechy/MCA.git').repo).toBe('milechy/MCA');
});
