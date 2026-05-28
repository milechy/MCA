const { test, expect } = require('@playwright/test');
const { clamp } = require('../../src/ralph/utils/clamp');

test('clamp: happy path — value within bounds', () => {
  expect(clamp(5, 0, 10)).toBe(5);
});

test('clamp: value below min — returns min', () => {
  expect(clamp(-3, 0, 10)).toBe(0);
});

test('clamp: value above max — returns max', () => {
  expect(clamp(20, 0, 10)).toBe(10);
});

test('clamp: zero input — returns zero when within bounds', () => {
  expect(clamp(0, -5, 5)).toBe(0);
});

test('clamp: throws TypeError when value is not a number', () => {
  expect(() => clamp('5', 0, 10)).toThrow(TypeError);
});

test('clamp: throws RangeError when min > max', () => {
  expect(() => clamp(5, 10, 0)).toThrow(RangeError);
});
