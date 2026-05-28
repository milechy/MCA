const { test, expect } = require('@playwright/test');
const { range } = require('../../src/ralph/utils/range');

test('range: happy path with default step', () => {
  const result = range(0, 3);
  expect(result).toEqual([0, 1, 2]);
});

test('range: with custom step', () => {
  const result = range(0, 5, 2);
  expect(result).toEqual([0, 2, 4]);
});

test('range: empty range', () => {
  const result = range(5, 5);
  expect(result).toEqual([]);
});

test('range: throws when step is zero', () => {
  expect(() => range(0, 5, 0)).toThrow('step must be greater than 0');
});

test('range: throws when step is negative', () => {
  expect(() => range(0, 5, -1)).toThrow('step must be greater than 0');
});
