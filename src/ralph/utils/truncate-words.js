function truncateWords(str, n, suffix = '…') {
  if (typeof str !== 'string') {
    throw new TypeError('str must be a string');
  }
  if (typeof n !== 'number' || n < 0 || !Number.isInteger(n)) {
    throw new TypeError('n must be a non-negative integer');
  }
  if (typeof suffix !== 'string') {
    throw new TypeError('suffix must be a string');
  }

  const words = str.split(/\s+/).filter(word => word.length > 0);
  
  if (words.length <= n) {
    return str.trim();
  }
  
  return words.slice(0, n).join(' ') + suffix;
}

module.exports = { truncateWords };
