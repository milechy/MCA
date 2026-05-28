import { test, expect } from '@playwright/test';
import { groupBy } from '../../src/ralph/utils/group-by.js';

test('groupBy: happy path — groups objects by property', () => {
  const items = [
    { id: 1, type: 'a' },
    { id: 2, type: 'b' },
    { id: 3, type: 'a' }
  ];
  const result = groupBy(items, (x) => x.type);
  expect(result).toEqual({
    a: [
      { id: 1, type: 'a' },
      { id: 3, type: 'a' }
    ],
    b: [{ id: 2, type: 'b' }]
  });
});

test('groupBy: edge case from spec — groups with duplicate keys', () => {
  const items = [{ t: 'a' }, { t: 'b' }, { t: 'a' }];
  const result = groupBy(items, (x) => x.t);
  expect(result).toEqual({
    a: [{ t: 'a' }, { t: 'a' }],
    b: [{ t: 'b' }]
  });
});

test('groupBy: empty array input', () => {
  const result = groupBy([], (x) => x);
  expect(result).toEqual({});
});

test('groupBy: throws when first argument is not an array', () => {
  expect(() => {
    groupBy(null, (x) => x);
  }).toThrow(TypeError);
});

test('groupBy: throws when second argument is not a function', () => {
  expect(() => {
    groupBy([1, 2, 3], 'not-a-function');
  }).toThrow(TypeError);
});
