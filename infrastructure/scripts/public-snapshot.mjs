#!/usr/bin/env node
// Export reviewed current files, never Git history or arbitrary ignored content.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, copyFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const excluded = /^(?:data-import|data|tmp|temp|target|\.git|\.agents|\.dsh-pg|\.deploy|private-data|exports|backups|public-snapshot)(?:\/|$)|(?:^|\/)(?:node_modules|dist|test-results|playwright-report)(?:\/|$)/
const unsafe = /(?:^|\/)(?:\.env(?:\..*)?|\.envrc)$|\.(?:csv|xlsx?|ods|dump|bak|backup|zip|tgz|key|pem)$|\.tar(?:\..*)?$/i
const exceptions = new Set(['.env.example', '.env.production.template', 'crates/checkbook-api/tests/fixtures/private_rsa_key_pkcs8.pem'])
const candidates = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean)
const files = [...new Set(candidates)].filter((file) => {
  if (excluded.test(file) || (unsafe.test(file) && !exceptions.has(file))) return false
  const absolute = path.resolve(root, file)
  if (!absolute.startsWith(root + path.sep)) throw new Error('Path outside repository')
  if (!existsSync(absolute)) return false
  // Refuse symlink components as well as symlink files.
  let current = root
  for (const part of file.split('/')) {
    current = path.join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink requires manual review: ${file}`)
  }
  return lstatSync(absolute).isFile()
}).sort()
if (process.argv.length === 2) {
  process.stdout.write(files.join('\n') + '\n')
} else if (process.argv.length === 3) {
  const destination = path.resolve(process.argv[2])
  if (existsSync(destination)) throw new Error('Destination must not exist')
  if (destination === root || root.startsWith(destination + path.sep)) throw new Error('Unsafe destination')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const file of files) {
    const output = path.join(destination, file)
    mkdirSync(path.dirname(output), { recursive: true })
    copyFileSync(path.join(root, file), output)
  }
  writeFileSync(path.join(destination, 'SNAPSHOT-MANIFEST.txt'), files.join('\n') + '\n')
  console.log(`Copied ${files.length} files; review SNAPSHOT-MANIFEST.txt and scan before publication.`)
} else {
  throw new Error('Usage: node infrastructure/scripts/public-snapshot.mjs [NEW_DESTINATION]')
}
