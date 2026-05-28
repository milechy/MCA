import { test, expect } from '@playwright/test';
import { kebabCase } from '../../src/ralph/utils/kebab-case.js';

test('kebabCase: happy path - camelCase to kebab-case', () => {
  expect(kebabCase('helloWorld')).toBe('hello-world');
});

test('kebabCase: UPPER_SNAKE_CASE to kebab-case', () => {
  expect(kebabCase('HELLO_WORLD')).toBe('hello-world');
});

test('kebabCase: space-separated words to kebab-case', () => {
  expect(kebabCase('Hello World')).toBe('hello-world');
});

test('kebabCase: empty string returns empty string', () => {
  expect(kebabCase('')).toBe('');
});

test('kebabCase: throws TypeError for non-string input', () => {
  expect(() => kebabCase(null)).toThrow(TypeError);
  expect(() => kebabCase(123)).toThrow(TypeError);
  expect(() => kebabCase(undefined)).toThrow(TypeError);
});
