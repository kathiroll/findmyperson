import { defineConfig } from 'vitest/config';

// One command (`pnpm test`) runs the tests of every workspace member.
export default defineConfig({
  test: {
    projects: ['app', 'packages/*', 'server'],
  },
});
