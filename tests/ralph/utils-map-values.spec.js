const { test, expect } = require('@playwright/test');
const { mapValues } = require('../../src/ralph/utils/map-values');

test('mapValues: happy path — transforms values with function', () => {
  const input = { a: 1, b: 2, c: 3 };
  const result = mapValues(input, (v) => v * 10);
  expect(result).toEqual({ a: 10, b: 20, c: 30 });
});

test('mapValues: spec example — {a:1,b:2} with v=>v*10 yields {a:10,b:20}', () => {
  const result = mapValues({ a: 1, b: 2 }, (v) => v * 10);
  expect(result).toEqual({ a: 10, b: 20 });
});

test('mapValues: empty object — returns empty object', () => {
  const result = mapValues({}, (v) => v * 2);
  expect(result).toEqual({});
});

test('mapValues: function receives both value and key', () => {
  const keys = [];
  const values = [];
  mapValues({ x: 'hello', y: 'world' }, (v, k) => {
    keys.push(k);
    values.push(v);
    return v.toUpperCase();
  });
  expect(keys).toEqual(['x', 'y']);
  expect(values).toEqual(['hello', 'world']);
});

test('mapValues: throws when fn is not a function', () => {
  expect(() => {
    mapValues({ a: 1 }, null);
  }).toThrow();
});

test('mapValues: preserves key order', () => {
  const input = { z: 1, a: 2, m: 3 };
  const result = mapValues(input, (v) => v * 2);
  expect(Object.keys(result)).toEqual(['z', 'a', 'm']);
});

test('mapValues: does not mutate original object', () => {
  const original = { a: 1, b: 2 };
  const result = mapValues(original, (v) => v * 10);
  expect(original).toEqual({ a: 1, b: 2 });
  expect(result).toEqual({ a: 10, b: 20 });
});
