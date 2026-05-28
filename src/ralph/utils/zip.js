function zip(a, b) {
  const minLength = Math.min(a.length, b.length);
  const result = [];
  for (let i = 0; i < minLength; i++) {
    result.push([a[i], b[i]]);
  }
  return result;
}

module.exports = { zip };
