import { defineConfig } from '@playwright/test'

const workerPort = Number(process.env.E2E_WORKER_PORT ?? 8793)
const mockPaypalPort = Number(process.env.MOCK_PAYPAL_PORT ?? 8799)

// Headless only, one worker: this PC allows one browser test run at a time across every project.
export default defineConfig({
  testDir: 'e2e',
  // Hosted runs spend the live app's daily caps: only playwright.hosted.config.ts runs them.
  testIgnore: 'hosted/**',
  workers: 1,
  timeout: 120_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${workerPort}`, headless: true, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node e2e/mock-paypal.mjs', url: `http://127.0.0.1:${mockPaypalPort}/__health`, reuseExistingServer: false, timeout: 20_000 },
    { command: 'npm run desk:build && node e2e/start-worker.mjs', url: `http://127.0.0.1:${workerPort}/health`, reuseExistingServer: false, timeout: 180_000 },
  ],
})
