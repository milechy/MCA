import { test, expect } from '@playwright/test';
import { truncateWords } from '../../src/ralph/utils/truncate-words.js';

test('truncateWords: happy path — truncates and appends suffix', () => {
  const result = truncateWords('a b c d', 2);
  expect(result).toBe('a b…');
});

test('truncateWords: spec example — keeps first n words with default suffix', () => {
  const result = truncateWords('a b c d', 2);
  expect(result).toBe('a b…');
});

test('truncateWords: no truncation needed — returns original when words <= n', () => {
  const result = truncateWords('a b c', 5);
  expect(result).toBe('a b c');
});

test('truncateWords: empty string — returns empty string', () => {
  const result = truncateWords('', 2);
  expect(result).toBe('');
});

test('truncateWords: zero words requested — returns empty with suffix', () => {
  const result = truncateWords('a b c', 0);
  expect(result).toBe('…');
});

test('truncateWords: custom suffix — uses provided suffix', () => {
  const result = truncateWords('a b c d', 2, '...');
  expect(result).toBe('a b...');
});

test('truncateWords: whitespace handling — normalizes multiple spaces', () => {
  const result = truncateWords('a  b   c    d', 2);
  expect(result).toBe('a b…');
});

test('truncateWords: invalid str type — throws TypeError', () => {
  expect(() => truncateWords(123, 2)).toThrow(TypeError);
});

test('truncateWords: invalid n type — throws TypeError', () => {
  expect(() => truncateWords('a b c', 'two')).toThrow(TypeError);
});

test('truncateWords: negative n — throws TypeError', () => {
  expect(() => truncateWords('a b c', -1)).toThrow(TypeError);
});

test('truncateWords: non-integer n — throws TypeError', () => {
  expect(() => truncateWords('a b c', 2.5)).toThrow(TypeError);
});

test('truncateWords: invalid suffix type — throws TypeError', () => {
  expect(() => truncateWords('a b c', 2, 123)).toThrow(TypeError);
});
