import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const script = path.resolve('infrastructure/scripts/public-snapshot.mjs')
const manifest = execFileSync(process.execPath, [script], { encoding: 'utf8' }).trim().split('\n')
test('manifest contains application and reviewed examples, not private or generated content', () => {
  for (const expected of ['Cargo.toml', '.env.example', '.env.production.template', '.sqlx/' + manifest.find(f => f.startsWith('.sqlx/')).split('/')[1], 'frontend/src/features/utilities/UtilityColorPicker.tsx']) {
    assert.ok(manifest.includes(expected), expected)
  }
  assert.ok(manifest.every(f => !/^(data-import|data|tmp|target|\.git|\.agents|\.dsh-pg)\//.test(f)))
  assert.ok(manifest.every(f => !/(^|\/)(node_modules|dist|test-results|playwright-report)\//.test(f)))
  assert.ok(manifest.every(f => !/\.(csv|xlsx|pdf|dump|zip|tgz)$/.test(f)))
  assert.equal(new Set(manifest).size, manifest.length)
})
test('export copies current files, records exact manifest, refuses existing destinations', () => {
  mkdirSync('tmp', { recursive: true })
  const base = mkdtempSync(path.resolve('tmp/snapshot-test-'))
  const destination = path.join(base, 'export')
  execFileSync(process.execPath, [script, destination])
  assert.equal(readFileSync(path.join(destination, 'README.md'), 'utf8'), readFileSync('README.md', 'utf8'))
  assert.equal(readFileSync(path.join(destination, 'SNAPSHOT-MANIFEST.txt'), 'utf8'), manifest.join('\n') + '\n')
  assert.ok(!existsSync(path.join(destination, '.git')))
  writeFileSync(path.join(destination, 'keep'), 'do not overwrite')
  assert.notEqual(spawnSync(process.execPath, [script, destination]).status, 0)
  assert.equal(readFileSync(path.join(destination, 'keep'), 'utf8'), 'do not overwrite')
})
