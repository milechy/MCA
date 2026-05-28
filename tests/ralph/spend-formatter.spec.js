const { test, expect } = require('@playwright/test');
const { formatSpendUsd } = require('../../src/ralph/spend-formatter');

test('formatSpendUsd: positive number', () => {
  expect(formatSpendUsd(0.42121)).toBe('$0.42');
});

test('formatSpendUsd: zero', () => {
  expect(formatSpendUsd(0)).toBe('$0.00');
});

test('formatSpendUsd: small fraction', () => {
  expect(formatSpendUsd(0.0021999)).toBe('$0.00');
});

test('formatSpendUsd: large number', () => {
  expect(formatSpendUsd(5.00)).toBe('$5.00');
});

test('formatSpendUsd: large number with many decimals', () => {
  expect(formatSpendUsd(123.456789)).toBe('$123.46');
});

test('formatSpendUsd: negative number', () => {
  expect(formatSpendUsd(-1.5)).toBe('$-1.50');
});

test('formatSpendUsd: negative small fraction', () => {
  expect(formatSpendUsd(-0.0021999)).toBe('$-0.00');
});

test('formatSpendUsd: null returns $0.00', () => {
  expect(formatSpendUsd(null)).toBe('$0.00');
});

test('formatSpendUsd: undefined returns $0.00', () => {
  expect(formatSpendUsd(undefined)).toBe('$0.00');
});

test('formatSpendUsd: NaN returns $0.00', () => {
  expect(formatSpendUsd(NaN)).toBe('$0.00');
});

test('formatSpendUsd: rounding up at midpoint (0.005 rounds to $0.01)', () => {
  expect(formatSpendUsd(0.005)).toBe('$0.01');
});

test('formatSpendUsd: rounding down (0.004 rounds to $0.00)', () => {
  expect(formatSpendUsd(0.004)).toBe('$0.00');
});

test('formatSpendUsd: string number input', () => {
  expect(formatSpendUsd('42.5')).toBe('$42.50');
});

test('formatSpendUsd: very large number', () => {
  expect(formatSpendUsd(9999.999)).toBe('$10000.00');
});
