function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

module.exports = { clamp };
