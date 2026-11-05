import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The desk builds into the Worker's static assets folder.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8791', '/pay': 'http://127.0.0.1:8791', '/desk/config': 'http://127.0.0.1:8791' } },
  test: { environment: 'jsdom', include: ['src/__tests__/**/*.test.{ts,tsx}'] },
} as never)
