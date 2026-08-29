import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Load the project-root .env so Vite shares PORT with the Express server
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? '8787'}`,
      '/productimage': `http://localhost:${process.env.PORT ?? '8787'}`,
    },
  },
})
