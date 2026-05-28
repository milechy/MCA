function capitalize(str) {
  if (typeof str !== 'string') {
    throw new TypeError('capitalize expects a string');
  }
  if (str.length === 0) {
    return '';
  }
  return str[0].toUpperCase() + str.slice(1);
}

module.exports = { capitalize };
