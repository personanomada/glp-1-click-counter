import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

// Check if SSL certs exist (for local dev)
const keyPath = path.resolve(__dirname, 'localhost-key.pem')
const certPath = path.resolve(__dirname, 'localhost.pem')
const hasSSLCerts = fs.existsSync(keyPath) && fs.existsSync(certPath)

export default defineConfig({
  // Set base to repo name for GitHub Pages (change 'glp-1-click-counter' to your repo name)
  base: process.env.NODE_ENV === 'production' ? '/glp-1-click-counter/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    ...(hasSSLCerts && {
      https: {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      }
    })
  }
})
