import { test, expect } from '@playwright/test';
import { sumBy } from '../../src/ralph/utils/sum-by.js';

test('sumBy: happy path with objects', () => {
  const arr = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const result = sumBy(arr, (x) => x.n);
  expect(result).toBe(6);
});

test('sumBy: spec example', () => {
  const arr = [{ n: 1 }, { n: 2 }];
  const result = sumBy(arr, (x) => x.n);
  expect(result).toBe(3);
});

test('sumBy: empty array returns 0', () => {
  const arr = [];
  const result = sumBy(arr, (x) => x.n);
  expect(result).toBe(0);
});

test('sumBy: throws when first argument is not an array', () => {
  expect(() => {
    sumBy(null, (x) => x);
  }).toThrow(TypeError);
});

test('sumBy: throws when second argument is not a function', () => {
  expect(() => {
    sumBy([1, 2, 3], 'not a function');
  }).toThrow(TypeError);
});
