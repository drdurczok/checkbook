import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    setupFiles: ['./src/test/setup.ts'],
    // jsdom 29 intermittently fails while several fork workers initialize at
    // once in the constrained CI container. The suite is UI-bound rather than
    // CPU-bound, so one reusable fork is more reliable than parallel startup.
    pool: 'forks',
    singleFork: true,
    // The shared CI runner executes this suite 8-15x slower than a dev box
    // (174s of jsdom environment time for 26 files vs ~1s locally) and
    // contends with the Rust jobs. Tests that take well under 0.5s locally
    // can stall past vitest's 5s default there, so allow generous headroom.
    testTimeout: 15_000,
  },
})
