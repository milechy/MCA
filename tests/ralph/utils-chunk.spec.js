const { test, expect } = require('@playwright/test');
const { chunk } = require('../../src/ralph/utils/chunk');

test('chunk: happy path - splits array into equal-sized chunks', () => {
  const result = chunk([1, 2, 3, 4, 5, 6], 2);
  expect(result).toEqual([[1, 2], [3, 4], [5, 6]]);
});

test('chunk: edge case - remainder chunk smaller than size', () => {
  const result = chunk([1, 2, 3, 4, 5], 2);
  expect(result).toEqual([[1, 2], [3, 4], [5]]);
});

test('chunk: empty array input', () => {
  const result = chunk([], 2);
  expect(result).toEqual([]);
});

test('chunk: throws when size is zero or negative', () => {
  expect(() => chunk([1, 2, 3], 0)).toThrow('chunk size must be greater than 0');
  expect(() => chunk([1, 2, 3], -1)).toThrow('chunk size must be greater than 0');
});
