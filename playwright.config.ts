import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * End-to-end tests load the real unpacked extension in Chromium and start a real
 * agent server. Run `npm run build` before `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run start:mock-ollama',
      url: 'http://127.0.0.1:11435/api/version',
      reuseExistingServer: false,
      timeout: 10_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:server',
      url: 'http://127.0.0.1:4317/health',
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:fixtures',
      url: 'http://127.0.0.1:4173/basic-generic.html',
      reuseExistingServer: true,
      timeout: 10_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:server',
      url: 'http://127.0.0.1:4318/health',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        AGENT_PORT: '4318',
        AGENT_TOKEN: 'e2e-token-0123456789abcdef0123456789abcdef',
        AGENT_DATA_DIR: resolve('test-results', 'e2e-agent-data'),
        AGENT_LOG_LEVEL: 'error',
        OLLAMA_URL: 'http://127.0.0.1:11435',
        OLLAMA_MODEL: 'mock-grounded:latest',
      },
    },
  ],
});
