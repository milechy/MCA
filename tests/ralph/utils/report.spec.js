const { test, expect } = require('@playwright/test');
const { aggregate } = require('../../../src/ralph/utils/report');

test('all-success: returns correct counts and empty errors', () => {
  const results = [
    { ok: true, durationMs: 100 },
    { ok: true, durationMs: 200 },
    { ok: true, durationMs: 300 }
  ];

  const report = aggregate(results);

  expect(report.total).toBe(3);
  expect(report.succeeded).toBe(3);
  expect(report.failed).toBe(0);
  expect(report.avgDurationMs).toBeCloseTo(200);
  expect(report.errors).toEqual([]);
});

test('all-failure: returns correct counts and collects errors', () => {
  const results = [
    { ok: false, durationMs: 50, error: 'Error 1' },
    { ok: false, durationMs: 75, error: 'Error 2' },
    { ok: false, durationMs: 100, error: 'Error 3' }
  ];

  const report = aggregate(results);

  expect(report.total).toBe(3);
  expect(report.succeeded).toBe(0);
  expect(report.failed).toBe(3);
  expect(report.avgDurationMs).toBeCloseTo(75);
  expect(report.errors).toEqual(['Error 1', 'Error 2', 'Error 3']);
});

test('mixed: handles both success and failure', () => {
  const results = [
    { ok: true, durationMs: 100 },
    { ok: false, durationMs: 50, error: 'Failed task' },
    { ok: true, durationMs: 150 },
    { ok: false, durationMs: 75, error: 'Another failure' }
  ];

  const report = aggregate(results);

  expect(report.total).toBe(4);
  expect(report.succeeded).toBe(2);
  expect(report.failed).toBe(2);
  expect(report.avgDurationMs).toBeCloseTo(93.75);
  expect(report.errors).toEqual(['Failed task', 'Another failure']);
});

test('empty array: returns zeros and empty errors', () => {
  const results = [];

  const report = aggregate(results);

  expect(report.total).toBe(0);
  expect(report.succeeded).toBe(0);
  expect(report.failed).toBe(0);
  expect(report.avgDurationMs).toBe(0);
  expect(report.errors).toEqual([]);
});

test('avgDurationMs calculation: correctly computes arithmetic mean', () => {
  const results = [
    { ok: true, durationMs: 10 },
    { ok: true, durationMs: 20 },
    { ok: true, durationMs: 30 },
    { ok: true, durationMs: 40 }
  ];

  const report = aggregate(results);

  expect(report.avgDurationMs).toBeCloseTo(25);
});

test('handles results with missing durationMs', () => {
  const results = [
    { ok: true, durationMs: 100 },
    { ok: true },
    { ok: true, durationMs: 200 }
  ];

  const report = aggregate(results);

  expect(report.total).toBe(3);
  expect(report.succeeded).toBe(3);
  expect(report.avgDurationMs).toBeCloseTo(100);
});

test('handles error objects converted to strings', () => {
  const results = [
    { ok: false, durationMs: 50, error: new Error('Test error') },
    { ok: false, durationMs: 75, error: 'String error' }
  ];

  const report = aggregate(results);

  expect(report.failed).toBe(2);
  expect(report.errors.length).toBe(2);
  expect(report.errors[0]).toContain('Test error');
  expect(report.errors[1]).toBe('String error');
});

test('ignores results with ok=false but no error', () => {
  const results = [
    { ok: false, durationMs: 50 },
    { ok: false, durationMs: 75, error: 'Has error' },
    { ok: true, durationMs: 100 }
  ];

  const report = aggregate(results);

  expect(report.total).toBe(3);
  expect(report.failed).toBe(2);
  expect(report.errors).toEqual(['Has error']);
});
