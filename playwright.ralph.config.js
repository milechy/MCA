const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/ralph',
  fullyParallel: true,
  reporter: 'list',
  use: {}
});
