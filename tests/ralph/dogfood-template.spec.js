const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.resolve(__dirname, '../../docs/dogfood-template.md');

function templateText() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

test('Phase 6 #4: dogfood-template.md exists and is non-empty', () => {
  expect(fs.existsSync(TEMPLATE_PATH)).toBe(true);
  const text = templateText();
  expect(text.length).toBeGreaterThan(0);
});

test('Phase 6 #4: has all required level-2 headings', () => {
  const text = templateText();
  const requiredHeadings = [
    '## Test convention',
    '## APPEND-only rule',
    '## 250 LOC ceiling',
    '## Injectable deps pattern',
    '## Verbatim export contract',
    '## Spec injection checklist',
  ];
  for (const heading of requiredHeadings) {
    expect(text).toContain(heading);
  }
});

test('Phase 6 #4: Test convention section has bullet list', () => {
  const text = templateText();
  const section = text.split('## Test convention')[1].split('##')[0];
  expect(section).toMatch(/^\n*[^\n]*\n- /m);
});

test('Phase 6 #4: APPEND-only rule section has bullet list', () => {
  const text = templateText();
  const section = text.split('## APPEND-only rule')[1].split('##')[0];
  expect(section).toMatch(/^\n*[^\n]*\n- /m);
});

test('Phase 6 #4: 250 LOC ceiling section has paragraph', () => {
  const text = templateText();
  const section = text.split('## 250 LOC ceiling')[1].split('##')[0];
  expect(section.trim().length).toBeGreaterThan(0);
});

test('Phase 6 #4: Injectable deps pattern section has code block', () => {
  const text = templateText();
  const section = text.split('## Injectable deps pattern')[1].split('##')[0];
  expect(section).toContain('```js');
  expect(section).toContain('```');
});

test('Phase 6 #4: Verbatim export contract section has bullet list', () => {
  const text = templateText();
  const section = text.split('## Verbatim export contract')[1].split('##')[0];
  expect(section).toMatch(/^\n*[^\n]*\n- /m);
});

test('Phase 6 #4: Spec injection checklist is numbered list', () => {
  const text = templateText();
  const section = text.split('## Spec injection checklist')[1];
  expect(section).toMatch(/^\n*[^\n]*\n1\. /m);
});
