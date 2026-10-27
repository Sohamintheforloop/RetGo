import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Adds a Content-Security-Policy to the PRODUCTION build only (the dev server needs inline scripts).
 * The app only talks to itself, the edge Worker and the local patcher, so everything else is blocked.
 * If the packaged app ever shows a blank page, open the console: a CSP violation names what to allow.
 */
function csp(connect: string[]): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    name: 'rgap-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('</title>', `</title>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  }
}

// Tailwind v4: the Vite plugin replaces tailwind.config.js and postcss entirely.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const connect = [env.VITE_WORKER_URL || 'http://localhost:8787', env.VITE_PATCHER_URL || 'http://localhost:8000']
  return {
    base: './', // relative asset paths so the build also works when served from the packaged .exe
    plugins: [react(), tailwindcss(), csp(connect)],
  }
})
