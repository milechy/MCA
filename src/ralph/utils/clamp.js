function clamp(n, min, max) {
  if (typeof n !== 'number' || typeof min !== 'number' || typeof max !== 'number') {
    throw new TypeError('clamp arguments must be numbers');
  }
  if (min > max) {
    throw new RangeError('min must be less than or equal to max');
  }
  return Math.max(min, Math.min(max, n));
}

module.exports = { clamp };
