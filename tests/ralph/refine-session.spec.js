const { test, expect } = require('@playwright/test');

let S;
test.beforeAll(async () => { S = await import('../../telegram-worker/refine-session.mjs'); });

test('sessionKey + newSession', () => {
  expect(S.sessionKey(42)).toBe('refine:42');
  const s = S.newSession('doc text');
  expect(s.phase).toBe('idle');
  expect(s.doc).toBe('doc text');
  expect(s.qa).toEqual([]);
  expect(s.rounds).toBe(0);
});

test('buildGetFileRequest + fileDownloadUrl', () => {
  const r = S.buildGetFileRequest({ token: 'TOK', fileId: 'FID' });
  expect(r.ok).toBe(true);
  expect(r.url).toContain('/botTOK/getFile?file_id=FID');
  expect(S.fileDownloadUrl({ token: 'TOK', filePath: 'documents/x.md' })).toBe('https://api.telegram.org/file/botTOK/documents/x.md');
  expect(S.buildGetFileRequest({ token: 'T' }).ok).toBe(false);
});

test('extractDocOrText handles documents and text', () => {
  const d = S.extractDocOrText({ message: { document: { file_id: 'F', file_name: 'r.md' }, chat: { id: 9 } } });
  expect(d.kind).toBe('document'); expect(d.fileId).toBe('F'); expect(d.chatId).toBe(9);
  const t = S.extractDocOrText({ message: { text: ' hello ', chat: { id: 1 } } });
  expect(t.kind).toBe('text'); expect(t.text).toBe('hello');
});

test('looksLikeRequirements: doc always, long/multiline text yes, short no', () => {
  expect(S.looksLikeRequirements({ kind: 'document' })).toBe(true);
  expect(S.looksLikeRequirements({ kind: 'text', text: 'a\nb\nc\nd' })).toBe(true); // 4 lines
  expect(S.looksLikeRequirements({ kind: 'text', text: 'x'.repeat(300) })).toBe(true); // long
  expect(S.looksLikeRequirements({ kind: 'text', text: 'add a helper' })).toBe(false);
});

test('buildGetBacklogRequest builds an authed contents GET', () => {
  const r = S.buildGetBacklogRequest({ token: 'PAT', repo: 'o/r' });
  expect(r.ok).toBe(true);
  expect(r.url).toBe('https://api.github.com/repos/o/r/contents/.github/ralph-backlog.json');
  expect(r.init.headers.Authorization).toBe('Bearer PAT');
});

test('mergeBacklog appends new items and dedups by id', () => {
  const existing = { version: 'ralph-backlog-v1', items: [{ id: 'REQ-001', title: 'a', body: 'A' }] };
  const { backlog, added_count } = S.mergeBacklog(existing, [
    { id: 'REQ-001', title: 'dup', body: 'x' }, // dup → skipped
    { id: 'REQ-002', title: 'b', body: 'B' }
  ]);
  expect(added_count).toBe(1);
  expect(backlog.items.length).toBe(2);
  expect(backlog.items[1].id).toBe('REQ-002');
});

test('mergeBacklog handles empty/absent existing', () => {
  const { backlog, added_count } = S.mergeBacklog(null, [{ id: 'REQ-001', title: 'a', body: 'A' }]);
  expect(backlog.version).toBe('ralph-backlog-v1');
  expect(added_count).toBe(1);
});

test('buildPutBacklogRequest base64-encodes and includes sha', () => {
  const r = S.buildPutBacklogRequest({ token: 'PAT', repo: 'o/r', contentObj: { version: 'ralph-backlog-v1', items: [] }, sha: 'abc123' });
  expect(r.ok).toBe(true);
  expect(r.init.method).toBe('PUT');
  const body = JSON.parse(r.init.body);
  expect(body.sha).toBe('abc123');
  const decoded = Buffer.from(body.content, 'base64').toString('utf8');
  expect(JSON.parse(decoded).version).toBe('ralph-backlog-v1');
});

test('assignItemIds continues numbering past existing REQ ids', () => {
  const items = S.assignItemIds(
    [{ id: 'BL-1', title: 'a', body: 'A' }, { id: 'BL-2', title: 'b', body: 'B' }],
    [{ id: 'REQ-005', title: 'x', body: 'X' }, { id: 'BL-1', title: 'y', body: 'Y' }]
  );
  expect(items[0].id).toBe('REQ-006');
  expect(items[1].id).toBe('REQ-007');
});

test('assignItemIds starts at 001 with no existing', () => {
  const items = S.assignItemIds([{ id: 'BL-1', title: 'a', body: 'A' }], []);
  expect(items[0].id).toBe('REQ-001');
});

test('assignItemIds remaps depends_on through new ids (Phase 12 #2)', () => {
  const items = S.assignItemIds(
    [
      { id: 'BL-1', title: 'schema', body: 'A', depends_on: [] },
      { id: 'BL-2', title: 'api', body: 'B', depends_on: ['BL-1'] }
    ],
    [{ id: 'REQ-005', title: 'x', body: 'X' }]
  );
  expect(items[0].id).toBe('REQ-006');
  expect(items[1].id).toBe('REQ-007');
  expect(items[1].depends_on).toEqual(['REQ-006']);
  expect(items[0].depends_on).toBeUndefined();
});
