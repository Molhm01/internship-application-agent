import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'extension',
          environment: 'jsdom',
          include: ['tests/extension/**/*.test.ts', 'tests/extension/**/*.test.tsx'],
          setupFiles: ['tests/extension/setup.ts'],
        },
      },
    ],
  },
});
