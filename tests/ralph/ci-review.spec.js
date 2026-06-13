const { test, expect } = require('@playwright/test');

const { scanDanger } = require('../../scripts/ralph/ci-review');

test('scanDanger flags a hardcoded secret on an added line', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    '+++ b/x.js',
    '+const apiKey = "sk-abcdef0123456789ABCDEF";'
  ].join('\n');
  const issues = scanDanger(diff);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0].severity).toBe('high');
});

test('scanDanger flags eval() and rm -rf on absolute paths', () => {
  expect(scanDanger('+eval(userInput)').some((i) => /eval/.test(i.note))).toBe(true);
  expect(scanDanger('+  rm -rf /var/data').some((i) => /rm -rf/.test(i.note))).toBe(true);
});

test('scanDanger is clean for an ordinary added function', () => {
  const diff = [
    '+++ b/src/util.js',
    '+function isEven(n) { return n % 2 === 0; }',
    '+module.exports = { isEven };'
  ].join('\n');
  expect(scanDanger(diff)).toEqual([]);
});

test('scanDanger only inspects added lines (ignores removed/context)', () => {
  const diff = '-const apiKey = "sk-removedsecret0123456789";\n const x = 1;';
  expect(scanDanger(diff)).toEqual([]); // the secret is on a removed line
});
