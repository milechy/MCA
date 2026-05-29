const { test, expect } = require('@playwright/test');

const R = require('../../src/ralph/requirements-refiner');

test('buildAnalyzeRequest embeds doc + prior Q&A', () => {
  const r = R.buildAnalyzeRequest({ apiKey: 'K', doc: 'build a thing', qa: [{ q: 'auth?', a: 'oauth' }] });
  expect(r.ok).toBe(true);
  expect(r.url).toContain('openrouter.ai');
  const body = JSON.parse(r.init.body);
  expect(body.messages[0].content).toContain('requirements engineer');
  expect(body.messages[1].content).toContain('build a thing');
  expect(body.messages[1].content).toContain('Q1: auth?');
  expect(body.messages[1].content).toContain('A1: oauth');
});

test('buildAnalyzeRequest / buildDecomposeRequest reject missing inputs', () => {
  expect(R.buildAnalyzeRequest({ apiKey: 'K' }).ok).toBe(false);
  expect(R.buildDecomposeRequest({ doc: 'x' }).ok).toBe(false);
});

test('parseAnalysis extracts summary/features/questions/ready', () => {
  const content = '```json\n' + JSON.stringify({
    summary: 'A todo app',
    features: [{ name: 'add', description: 'add todo' }, { bad: 1 }],
    open_questions: ['storage?', '', 'auth?'],
    risks: ['no persistence specified'],
    ready: false
  }) + '\n```';
  const a = R.parseAnalysis(content);
  expect(a.summary).toBe('A todo app');
  expect(a.features.length).toBe(1); // bad one filtered
  expect(a.open_questions).toEqual(['storage?', 'auth?']);
  expect(a.risks.length).toBe(1);
  expect(a.ready).toBe(false);
});

test('parseAnalysis: empty open_questions implies ready', () => {
  const a = R.parseAnalysis(JSON.stringify({ summary: 'X', features: [], open_questions: [] }));
  expect(a.ready).toBe(true);
});

test('parseAnalysis returns null on garbage', () => {
  expect(R.parseAnalysis('no json')).toBe(null);
  expect(R.parseAnalysis(JSON.stringify({ features: [] }))).toBe(null); // no summary
});

test('parseDecomposition extracts ordered items with deps', () => {
  const content = JSON.stringify({
    items: [
      { id: 'BL-1', title: 'schema', body: '## Task\n`db.js`', depends_on: [] },
      { id: 'BL-2', title: 'api', body: '## Task\n`api.js`', depends_on: ['BL-1'] },
      { title: 'no id', body: 'b' } // id auto-filled
    ],
    notes: 'do BL-1 first'
  });
  const d = R.parseDecomposition(content);
  expect(d.items.length).toBe(3);
  expect(d.items[1].depends_on).toEqual(['BL-1']);
  expect(d.items[2].id).toBe('BL-3'); // auto-numbered
  expect(d.notes).toContain('BL-1 first');
});

test('parseDecomposition returns null when no valid items', () => {
  expect(R.parseDecomposition(JSON.stringify({ items: [] }))).toBe(null);
  expect(R.parseDecomposition('garbage')).toBe(null);
});

test('isApproval / isCancel recognize ja + en', () => {
  expect(R.isApproval('OK')).toBe(true);
  expect(R.isApproval('承認')).toBe(true);
  expect(R.isApproval('進めて')).toBe(true);
  expect(R.isApproval('まだ直したい')).toBe(false);
  expect(R.isCancel('キャンセル')).toBe(true);
  expect(R.isCancel('stop')).toBe(true);
  expect(R.isCancel('OK')).toBe(false);
});

test('nextStep walks the conversation state machine', () => {
  expect(R.nextStep({}).action).toBe('need_doc');
  expect(R.nextStep({ doc: 'x' }).action).toBe('analyze');
  expect(R.nextStep({ doc: 'x', analysis: { ready: false }, pendingQuestions: ['q?'] }).action).toBe('ask');
  expect(R.nextStep({ doc: 'x', analysis: { ready: true } }).action).toBe('decompose');
  expect(R.nextStep({ doc: 'x', analysis: { ready: true }, decomposition: { items: [{}] } }).action).toBe('present');
  expect(R.nextStep({ doc: 'x', analysis: { ready: true }, decomposition: { items: [{}] }, approved: true }).action).toBe('commit');
  expect(R.nextStep({ doc: 'x', cancelled: true }).action).toBe('cancel');
});

test('formatForApproval lists items with deps + prompt', () => {
  const s = R.formatForApproval({ items: [
    { id: 'BL-1', title: 'schema', depends_on: [] },
    { id: 'BL-2', title: 'api', depends_on: ['BL-1'] }
  ], notes: 'sequence matters' });
  expect(s).toMatch(/BL-1: schema/);
  expect(s).toMatch(/BL-2: api \(after BL-1\)/);
  expect(s).toMatch(/sequence matters/);
  expect(s).toMatch(/OK/);
});

test('toBacklogItems converts to ralph-backlog item shape', () => {
  const items = R.toBacklogItems({ items: [
    { id: 'BL-1', title: 'a', body: 'A' },
    { id: 'BL-2', title: 'b', body: 'B' }
  ] });
  expect(items[0].id).toBe('REQ-001');
  expect(items[1].id).toBe('REQ-002');
  expect(items[0].title).toBe('a');
  expect(items[0].body).toBe('A');
  expect(items[0].depends_on).toBeUndefined(); // no deps → field omitted
});

test('toBacklogItems remaps depends_on through the id translation (Phase 12 #2)', () => {
  const items = R.toBacklogItems({ items: [
    { id: 'BL-1', title: 'schema', body: 'A', depends_on: [] },
    { id: 'BL-2', title: 'api', body: 'B', depends_on: ['BL-1'] },
    { id: 'BL-3', title: 'ui', body: 'C', depends_on: ['BL-1', 'BL-2'] }
  ] });
  expect(items[1].depends_on).toEqual(['REQ-001']);
  expect(items[2].depends_on).toEqual(['REQ-001', 'REQ-002']);
  expect(items[0].depends_on).toBeUndefined();
});

test('formatQuestions numbers questions', () => {
  expect(R.formatQuestions(['a?', 'b?'])).toMatch(/1\. a\?/);
  expect(R.formatQuestions([])).toMatch(/no open questions/);
});
