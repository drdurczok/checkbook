import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // The CI runner is a shared 6-core container that also serves production:
  // four Chromium workers oversubscribe it and push tests past their
  // timeouts. Two workers there trade a little wall time for stability.
  workers: process.env.CI ? 2 : undefined,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Exercise shipped CSS: dev mode does not run production optimization.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      testMatch: 'app-shell.spec.ts',
      grep: /every add window keeps the rendered app visible/,
      use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' },
    },
  ],
})
