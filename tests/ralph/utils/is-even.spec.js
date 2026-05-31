const { test, expect } = require('@playwright/test');
const { isEven } = require('../../../src/ralph/utils/is-even');

test('returns true for even positive integers', () => {
  expect(isEven(2)).toBe(true);
  expect(isEven(4)).toBe(true);
});

test('returns false for odd positive integers', () => {
  expect(isEven(1)).toBe(false);
  expect(isEven(3)).toBe(false);
});

test('returns true for zero', () => {
  expect(isEven(0)).toBe(true);
});

test('returns true for negative even integers', () => {
  expect(isEven(-2)).toBe(true);
  expect(isEven(-4)).toBe(true);
});

test('returns false for negative odd integers', () => {
  expect(isEven(-1)).toBe(false);
  expect(isEven(-3)).toBe(false);
});

test('returns false for non-integers', () => {
  expect(isEven(2.5)).toBe(false);
  expect(isEven(-3.7)).toBe(false);
});
