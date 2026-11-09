// Regenerates the dev-build icon variant in frontend/brand/dev from the
// production icons in frontend/public. Run manually with plain Node (stdlib
// only) whenever the production icons change:
//
//   node scripts/generate-dev-branding.mjs
//
// The transform recolors the brand hue range (green through blue, the colors
// shared by the favicon gradient, badge, fold tint, and ink lines) onto a warm
// amber/orange range while preserving each pixel's saturation, lightness, and
// alpha. Geometry and anti-aliasing are therefore identical to production; only
// the hue family changes, which is what makes dev deployments distinguishable
// from production at a glance.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(frontendRoot, 'public')
const outDir = resolve(frontendRoot, 'brand/dev')

// Saturated hues inside this gate are remapped; everything else is untouched.
const GATE_LO = 140
const GATE_HI = 250
// Linear map of the gradient span green(#12946f, ~160°) .. blue(#2563eb, ~221°)
// onto orange(~26°) .. amber(~45°). Values inside the gate but outside the
// span clamp to the endpoints so stray anti-aliased hues stay warm.
const SPAN_LO = 155
const SPAN_HI = 235
const TARGET_LO = 25
const TARGET_HI = 48
const MIN_SATURATION = 0.12

function mapHue(h) {
  const t = Math.min(1, Math.max(0, (h - SPAN_LO) / (SPAN_HI - SPAN_LO)))
  return TARGET_LO + t * (TARGET_HI - TARGET_LO)
}

function remapPixel(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [r, g, b]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  if (s < MIN_SATURATION) return [r, g, b]
  let h
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  if (h < GATE_LO || h > GATE_HI) return [r, g, b]
  return hslToRgb(mapHue(h), s, l)
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rn = 0
  let gn = 0
  let bn = 0
  if (hp < 1) [rn, gn, bn] = [c, x, 0]
  else if (hp < 2) [rn, gn, bn] = [x, c, 0]
  else if (hp < 3) [rn, gn, bn] = [0, c, x]
  else if (hp < 4) [rn, gn, bn] = [0, x, c]
  else if (hp < 5) [rn, gn, bn] = [x, 0, c]
  else [rn, gn, bn] = [c, 0, x]
  const m = l - c / 2
  return [
    Math.round((rn + m) * 255),
    Math.round((gn + m) * 255),
    Math.round((bn + m) * 255),
  ]
}

function remapHex(hex) {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const [rr, rg, rb] = remapPixel(r, g, b)
  return (
    '#' +
    [rr, rg, rb]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

function generateFavicon() {
  const source = readFileSync(resolve(publicDir, 'favicon.svg'), 'utf8')
  const hexes = [...new Set(source.match(/#[0-9a-fA-F]{6}\b/g))]
  let out = source
  const notes = []
  for (const hex of hexes) {
    const mapped = remapHex(hex)
    if (mapped.toLowerCase() === hex.toLowerCase()) continue
    out = out.replaceAll(hex, mapped)
    notes.push(`${hex} -> ${mapped}`)
  }
  writeFileSync(resolve(outDir, 'favicon.svg'), out)
  console.log('favicon.svg:', notes.join(', ') || 'no color changes')
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0)
  return Buffer.concat([head, data, crc])
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  const ancillary = []
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('expected 8-bit RGBA non-interlaced PNG')
      }
      ancillary.push({ type, data: Buffer.from(data) })
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    else ancillary.push({ type, data: Buffer.from(data) })
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const px = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const row = raw.subarray(rp, rp + stride)
    rp += stride
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    const cur = px.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = x >= bpp && prev ? prev[x - bpp] : 0
      let v = row[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pred) & 0xff
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter}`)
      }
      cur[x] = v
    }
  }
  return { width, height, px, ancillary }
}

function encodePng({ width, height, px, ancillary }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  for (const { type, data } of ancillary) parts.push(chunk(type, data))
  parts.push(chunk('IDAT', deflateSync(raw, { level: 9 })))
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

function generatePng(name) {
  const decoded = decodePng(readFileSync(resolve(publicDir, name)))
  const { px } = decoded
  let changed = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue
    const [r, g, b] = remapPixel(px[i], px[i + 1], px[i + 2])
    if (r !== px[i] || g !== px[i + 1] || b !== px[i + 2]) {
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      changed++
    }
  }
  writeFileSync(resolve(outDir, name), encodePng(decoded))
  const total = px.length / 4
  console.log(`${name}: recolored ${changed}/${total} pixels (${((changed / total) * 100).toFixed(1)}%)`)
}

mkdirSync(outDir, { recursive: true })
generateFavicon()
generatePng('app-icon-192.png')
generatePng('app-icon-512.png')
generatePng('app-icon-maskable-512.png')
