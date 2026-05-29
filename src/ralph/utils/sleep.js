function sleep(ms) {
  // Normalize input: treat non-numbers and negative values as 0
  const delay = typeof ms === 'number' && ms >= 0 ? ms : 0;
  
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

module.exports = { sleep };
