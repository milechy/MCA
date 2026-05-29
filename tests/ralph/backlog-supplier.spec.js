const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadBacklog,
  extractFiledIds,
  extractDoneIds,
  isValidItem,
  selectNextItem,
  pickFromBacklog,
  issueTitleFor
} = require('../../src/ralph/backlog-supplier');

function tmpBacklog(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'));
  const p = path.join(dir, 'backlog.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

const item = (id, extra = {}) => ({ id, title: `task ${id}`, body: `body ${id}`, ...extra });

test('loadBacklog reads items; reports missing/parse errors', () => {
  const p = tmpBacklog({ version: 'ralph-backlog-v1', items: [item('A')] });
  const ok = loadBacklog(p);
  expect(ok.ok).toBe(true);
  expect(ok.items.length).toBe(1);

  expect(loadBacklog('/no/such/file.json').reason).toBe('backlog_not_found');

  const bad = path.join(os.tmpdir(), `bad-${Date.now()}.json`);
  fs.writeFileSync(bad, '{ not json', 'utf8');
  expect(loadBacklog(bad).reason).toBe('backlog_parse_error');
});

test('extractFiledIds parses [<id>] from issue titles', () => {
  const ids = extractFiledIds(['[BL-001] add sleep', '[BL-002] add once', 'unrelated issue', '[X-9] thing']);
  expect(ids.has('BL-001')).toBe(true);
  expect(ids.has('BL-002')).toBe(true);
  expect(ids.has('X-9')).toBe(true);
  expect(ids.size).toBe(3);
});

test('isValidItem requires id, title, body', () => {
  expect(isValidItem(item('A'))).toBe(true);
  expect(isValidItem({ id: 'A', title: 'x' })).toBe(false);
  expect(isValidItem({ id: '', title: 'x', body: 'y' })).toBe(false);
  expect(isValidItem(null)).toBe(false);
});

test('selectNextItem returns first un-filed valid item', () => {
  const items = [item('A'), item('B'), item('C')];
  const r = selectNextItem({ items, filedIds: new Set(['A']) });
  expect(r.ok).toBe(true);
  expect(r.item.id).toBe('B');
  expect(r.item.labels).toEqual(['aider-fix']);
});

test('selectNextItem honors custom labels', () => {
  const items = [item('A', { labels: ['aider-fix', 'priority'] })];
  const r = selectNextItem({ items, filedIds: new Set() });
  expect(r.item.labels).toEqual(['aider-fix', 'priority']);
});

test('selectNextItem skips when too many open PRs', () => {
  const items = [item('A')];
  const r = selectNextItem({ items, filedIds: new Set(), openPrs: 3, maxOpenPrs: 3 });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('too_many_open_prs');
});

test('selectNextItem reports backlog_exhausted when all filed', () => {
  const items = [item('A'), item('B')];
  const r = selectNextItem({ items, filedIds: new Set(['A', 'B']) });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('backlog_exhausted');
});

test('selectNextItem skips invalid items', () => {
  const items = [{ id: 'BAD', title: 'no body' }, item('GOOD')];
  const r = selectNextItem({ items, filedIds: new Set() });
  expect(r.item.id).toBe('GOOD');
});

test('pickFromBacklog: load + select end to end (issues with state)', () => {
  const p = tmpBacklog({ version: 'ralph-backlog-v1', items: [item('BL-001'), item('BL-002')] });
  const r = pickFromBacklog({ backlogPath: p, issues: [{ title: '[BL-001] task BL-001', state: 'CLOSED' }], openPrs: 0, maxOpenPrs: 3 });
  expect(r.ok).toBe(true);
  expect(r.item.id).toBe('BL-002');
  expect(r.total_items).toBe(2);
  expect(r.filed_count).toBe(1);
  expect(r.done_count).toBe(1);
});

test('extractDoneIds only counts CLOSED issues', () => {
  const done = extractDoneIds([
    { title: '[A] x', state: 'CLOSED' },
    { title: '[B] y', state: 'OPEN' },
    { title: '[C] z', state: 'closed' }
  ]);
  expect(done.has('A')).toBe(true);
  expect(done.has('C')).toBe(true);
  expect(done.has('B')).toBe(false);
});

test('selectNextItem blocks an item until its depends_on are DONE', () => {
  const items = [
    { id: 'A', title: 'a', body: 'A' },
    { id: 'B', title: 'b', body: 'B', depends_on: ['A'] }
  ];
  // A filed but still OPEN (not done) → B blocked, A already filed → blocked_on_deps
  let r = selectNextItem({ items, filedIds: new Set(['A']), doneIds: new Set(), openPrs: 0, maxOpenPrs: 3 });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('blocked_on_deps');
  // A done → B becomes eligible
  r = selectNextItem({ items, filedIds: new Set(['A']), doneIds: new Set(['A']), openPrs: 0, maxOpenPrs: 3 });
  expect(r.ok).toBe(true);
  expect(r.item.id).toBe('B');
});

test('selectNextItem skips a blocked item to file a later independent one', () => {
  const items = [
    { id: 'A', title: 'a', body: 'A' },
    { id: 'B', title: 'b', body: 'B', depends_on: ['A'] },
    { id: 'C', title: 'c', body: 'C' } // independent
  ];
  // A filed+open, B blocked, C free → pick C
  const r = selectNextItem({ items, filedIds: new Set(['A']), doneIds: new Set(), openPrs: 0, maxOpenPrs: 3 });
  expect(r.item.id).toBe('C');
});

test('selectNextItem with no deps behaves as before', () => {
  const items = [item('A'), item('B')];
  const r = selectNextItem({ items, filedIds: new Set(['A']) });
  expect(r.item.id).toBe('B');
});

test('pickFromBacklog surfaces load failure', () => {
  const r = pickFromBacklog({ backlogPath: '/no/file.json' });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('backlog_not_found');
});

test('issueTitleFor embeds the id for round-trip dedup', () => {
  const title = issueTitleFor({ id: 'BL-007', title: 'add thing' });
  expect(title).toBe('[BL-007] add thing');
  // round-trips through extractFiledIds
  expect(extractFiledIds([title]).has('BL-007')).toBe(true);
});

test('the real seed backlog parses and yields BL-001 first', () => {
  const r = pickFromBacklog({ backlogPath: '.github/ralph-backlog.json', issueTitles: [], openPrs: 0, maxOpenPrs: 3 });
  expect(r.ok).toBe(true);
  expect(r.item.id).toBe('BL-001');
  expect(r.item.body).toMatch(/src\/ralph\/utils\/sleep\.js/);
});
