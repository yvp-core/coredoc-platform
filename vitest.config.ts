import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'coredoc-parsers/*/parser.test.ts'
    ],
    exclude: [
      'coredoc-parsers/**/fixtures/**',
      'node_modules/**',
      '**/node_modules/**',
      '**/dist/**'
    ]
  }
})
