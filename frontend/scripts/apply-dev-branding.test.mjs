import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(scriptsDir, '..')
const scriptPath = join(scriptsDir, 'apply-dev-branding.mjs')
const brandDir = join(frontendRoot, 'brand/dev')

const ICONS = [
  'favicon.svg',
  'app-icon-192.png',
  'app-icon-512.png',
  'app-icon-maskable-512.png',
]

const createdDirs = []

function makeDistFixture() {
  const distDir = mkdtempSync(join(tmpdir(), 'checkbook-branding-'))
  createdDirs.push(distDir)
  for (const name of ICONS) {
    writeFileSync(join(distDir, name), `production ${name} placeholder`)
  }
  writeFileSync(join(distDir, 'index.html'), '<link rel="icon" href="/favicon.svg" />')
  writeFileSync(join(distDir, 'manifest.webmanifest'), '{"icons":[]}')
  writeFileSync(join(distDir, 'service-worker.js'), "const CACHE_NAME = 'checkbook-shell-v1'\n")
  return distDir
}

function runScript(distDir, env) {
  return spawnSync(process.execPath, [scriptPath, '--dist', distDir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
})

describe('apply-dev-branding', () => {
  let distDir

  beforeEach(() => {
    distDir = makeDistFixture()
  })

  it('leaves the build output untouched when dev auth is not enabled', () => {
    for (const value of [undefined, 'false']) {
      const result = runScript(distDir, value === undefined ? { VITE_ENABLE_DEV_AUTH: '' } : { VITE_ENABLE_DEV_AUTH: value })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(distDir, 'favicon.svg'), 'utf8')).toBe(
        'production favicon.svg placeholder',
      )
      expect(readFileSync(join(distDir, 'service-worker.js'), 'utf8')).toContain(
        "'checkbook-shell-v1'",
      )
    }
  })

  it('swaps icons and bumps the shell cache name for dev builds', () => {
    const result = runScript(distDir, { VITE_ENABLE_DEV_AUTH: 'true' })
    expect(result.status, result.stderr).toBe(0)

    for (const name of ICONS) {
      expect(readFileSync(join(distDir, name))).toEqual(readFileSync(join(brandDir, name)))
    }
    expect(readFileSync(join(distDir, 'index.html'), 'utf8')).toBe(
      '<link rel="icon" href="/favicon.svg" />',
    )
    expect(readFileSync(join(distDir, 'manifest.webmanifest'), 'utf8')).toBe('{"icons":[]}')
    expect(readFileSync(join(distDir, 'service-worker.js'), 'utf8')).toBe(
      "const CACHE_NAME = 'checkbook-shell-dev-v1'\n",
    )
  })

  it('fails loudly when the build output is incomplete', () => {
    mkdirSync(join(distDir, 'empty'), { recursive: true })
    const emptyDist = join(distDir, 'empty')
    const result = runScript(emptyDist, { VITE_ENABLE_DEV_AUTH: 'true' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('apply-dev-branding')
  })
})
