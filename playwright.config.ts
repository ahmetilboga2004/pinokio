import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  workers: 1,
  reporter: 'list',
  webServer: {
    command: 'node tests/server.mjs',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  },
});
