import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: { baseURL: process.env.PUBLIC_TEST_URL || 'http://localhost:8080', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'], browserName: 'chromium' as const } },
    ...(process.env.PLAYWRIGHT_WEBKIT === '1' ? [{ name: 'webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' as const } }] : []),
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
});
