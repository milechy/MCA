function formatSpendUsd(value) {
  // Handle null, undefined, and NaN
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '$0.00';
  }

  // Convert to number if needed
  const num = Number(value);

  // Handle NaN after conversion
  if (Number.isNaN(num)) {
    return '$0.00';
  }

  // Format with exactly 2 decimal places
  return `$${num.toFixed(2)}`;
}

module.exports = { formatSpendUsd };
