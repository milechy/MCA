const { test, expect } = require('@playwright/test');
const { uniqueBy } = require('../../src/ralph/utils/unique-by');

test('uniqueBy: happy path — deduplicates objects by id', () => {
  const input = [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 1, name: 'Alice2' }
  ];
  const result = uniqueBy(input, (x) => x.id);
  expect(result).toEqual([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' }
  ]);
});

test('uniqueBy: spec example — [{id:1},{id:2},{id:1}] with x=>x.id', () => {
  const input = [{ id: 1 }, { id: 2 }, { id: 1 }];
  const result = uniqueBy(input, (x) => x.id);
  expect(result).toEqual([{ id: 1 }, { id: 2 }]);
});

test('uniqueBy: empty array input', () => {
  const result = uniqueBy([], (x) => x);
  expect(result).toEqual([]);
});

test('uniqueBy: throws TypeError when first argument is not an array', () => {
  expect(() => uniqueBy(null, (x) => x)).toThrow(TypeError);
  expect(() => uniqueBy('not an array', (x) => x)).toThrow(TypeError);
  expect(() => uniqueBy({ a: 1 }, (x) => x)).toThrow(TypeError);
});

test('uniqueBy: throws TypeError when second argument is not a function', () => {
  expect(() => uniqueBy([1, 2, 3], null)).toThrow(TypeError);
  expect(() => uniqueBy([1, 2, 3], 'not a function')).toThrow(TypeError);
  expect(() => uniqueBy([1, 2, 3], 42)).toThrow(TypeError);
});

test('uniqueBy: preserves first-occurrence order with string keys', () => {
  const input = [
    { name: 'Charlie' },
    { name: 'Alice' },
    { name: 'Bob' },
    { name: 'Alice' },
    { name: 'Charlie' }
  ];
  const result = uniqueBy(input, (x) => x.name);
  expect(result).toEqual([
    { name: 'Charlie' },
    { name: 'Alice' },
    { name: 'Bob' }
  ]);
});
