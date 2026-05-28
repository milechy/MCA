const { test, expect } = require('@playwright/test');
const { partition } = require('../../src/ralph/utils/partition');

test('partition: happy path with even/odd split', () => {
  const result = partition([1, 2, 3, 4], (x) => x % 2 === 0);
  expect(result).toEqual([[2, 4], [1, 3]]);
});

test('partition: spec example — even numbers', () => {
  const result = partition([1, 2, 3, 4], (x) => x % 2 === 0);
  expect(result[0]).toEqual([2, 4]);
  expect(result[1]).toEqual([1, 3]);
});

test('partition: empty array returns two empty arrays', () => {
  const result = partition([], (x) => x > 0);
  expect(result).toEqual([[], []]);
});

test('partition: throws when predicate is not a function', () => {
  expect(() => {
    partition([1, 2, 3], null);
  }).toThrow();
});
