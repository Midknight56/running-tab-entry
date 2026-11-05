import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e/hosted',
  workers: 1,
  timeout: 300_000,
  retries: 0,
  use: {
    baseURL: process.env.RT_BASE ?? 'https://running-tab.midknight-labs.workers.dev',
    headless: true,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    screenshot: 'on',
  },
  outputDir: 'captures/hosted',
})
