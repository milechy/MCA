function chunk(arr, size) {
  if (size <= 0) {
    throw new Error('chunk size must be greater than 0');
  }
  
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

module.exports = { chunk };
