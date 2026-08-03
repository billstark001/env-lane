import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@env-lane/core/env-document': fileURLToPath(
        new URL('./packages/core/src/env-document.ts', import.meta.url),
      ),
      '@env-lane/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
})
