import { test, expect } from '@playwright/test';
import { zip } from '../../src/ralph/utils/zip.js';

test('zip: happy path with equal-length arrays', () => {
  const result = zip([1, 2, 3], ['a', 'b', 'c']);
  expect(result).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
});

test('zip: truncates to shorter array length', () => {
  const result = zip([1, 2, 3, 4, 5], ['a', 'b', 'c']);
  expect(result).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
});

test('zip: handles empty arrays', () => {
  const result = zip([], []);
  expect(result).toEqual([]);
});

test('zip: throws when first argument is not an array', () => {
  expect(() => zip(null, ['a', 'b'])).toThrow();
});
