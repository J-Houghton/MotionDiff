// vite.config.js
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// The build stamp for the version footer: short commit and date, so a
// deploy (or a phone's cached copy) can be told apart at a glance.
const stamp = () => {
  let commit = 'dev'
  try { commit = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* not a checkout */ }
  const date = new Date().toISOString().slice(0, 10)
  return `${commit} · ${date}`
}

export default defineConfig({
  base: '/MotionDiff/',
  define: {
    __BUILD_STAMP__: JSON.stringify(stamp()),
  },
})
