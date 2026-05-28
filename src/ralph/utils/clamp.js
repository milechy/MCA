function clamp(value, min, max) {
  if (typeof value !== 'number' || typeof min !== 'number' || typeof max !== 'number') {
    throw new TypeError('clamp requires three numeric arguments');
  }
  if (min > max) {
    throw new RangeError('min must be less than or equal to max');
  }
  return Math.max(min, Math.min(max, value));
}

module.exports = { clamp };
