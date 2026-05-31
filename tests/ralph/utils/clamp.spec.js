const { clamp } = require('../../../src/ralph/utils/clamp');

test('in-range value is returned unchanged', () => {
  expect(clamp(5, 0, 10)).toBe(5);
});

test('below-min value is clamped to min', () => {
  expect(clamp(-3, 0, 10)).toBe(0);
});

test('above-max value is clamped to max', () => {
  expect(clamp(15, 0, 10)).toBe(10);
});

test('equal-bound cases return the bound', () => {
  expect(clamp(0, 0, 10)).toBe(0);
  expect(clamp(10, 0, 10)).toBe(10);
});
