const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/telegram',
  fullyParallel: true,
  reporter: 'list',
  use: {}
});
