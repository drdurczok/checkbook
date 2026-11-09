// Post-build step: swaps the production app icons for the amber dev variant
// when the build is a development build, so deployed dev and production apps
// are distinguishable by their tab and installed-home-screen icons.
//
// The variant is selected by the same build-time flag the rest of the frontend
// uses to identify a development deployment: VITE_ENABLE_DEV_AUTH === 'true'
// (set by the CI dev image build and the local compose stack; unset or 'false'
// for production builds, which leaves dist/ untouched).
//
// The icons keep their production filenames, so index.html, the web manifest,
// and the service worker need no per-variant rewiring. The service worker cache
// name is bumped so devices that already cached the previous production-blue
// icons from the dev origin pick up the dev icons.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = resolve(frontendRoot, 'brand/dev')

const ICONS = [
  'favicon.svg',
  'app-icon-192.png',
  'app-icon-512.png',
  'app-icon-maskable-512.png',
]

const PROD_CACHE_NAME = 'checkbook-shell-v1'
const DEV_CACHE_NAME = 'checkbook-shell-dev-v1'

function distDirFromArgs() {
  const index = process.argv.indexOf('--dist')
  if (index !== -1 && index + 1 < process.argv.length) return resolve(process.argv[index + 1])
  return resolve(frontendRoot, 'dist')
}

function applyDevBranding(distDir) {
  for (const name of ICONS) {
    const source = resolve(brandDir, name)
    const target = resolve(distDir, name)
    if (!existsSync(source)) {
      throw new Error(`dev icon variant is missing: ${source} (run scripts/generate-dev-branding.mjs)`)
    }
    if (!existsSync(target)) {
      throw new Error(`expected build output is missing: ${target}`)
    }
    copyFileSync(source, target)
  }

  const workerPath = resolve(distDir, 'service-worker.js')
  if (!existsSync(workerPath)) {
    throw new Error(`expected build output is missing: ${workerPath}`)
  }
  const worker = readFileSync(workerPath, 'utf8')
  const occurrences = worker.split(PROD_CACHE_NAME).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one '${PROD_CACHE_NAME}' in service-worker.js, found ${occurrences}`,
    )
  }
  writeFileSync(workerPath, worker.replace(PROD_CACHE_NAME, DEV_CACHE_NAME))
}

const isDevBuild = process.env.VITE_ENABLE_DEV_AUTH === 'true'

if (!isDevBuild) {
  console.log('apply-dev-branding: production build, keeping production icons')
} else {
  applyDevBranding(distDirFromArgs())
  console.log('apply-dev-branding: applied dev icon variant and bumped the shell cache name')
}
