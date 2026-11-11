import { expect, test } from 'claude-code/testing'

import type { Entry } from '../types'
import { LIFE, nodeOf, rasterFrame, svgFrame, timing } from '../hooks/graph'
import { pixelFrame, pixelSize } from '../hooks/pixels'

const read: Entry = { id: 'a', at: 1000, kind: 'tool', label: 'Read', detail: '/x', status: 'ok', ms: 0 }

test('edges grow in, fade out, and running ones stay lit', () => {
  expect(nodeOf(read)).toBe('files')
  expect(timing(read, 1000).grow).toBe(0)
  expect(Math.abs(timing(read, 1000 + LIFE / 2).alpha - 0.5) < 1e-9).toBe(true)
  expect(timing(read, 1000 + LIFE + 1).alpha).toBe(0)
  expect(timing({ ...read, status: 'run' }, 1000 + LIFE * 3).alpha).toBe(1)
})

test('frames come out in the shapes the surfaces take', () => {
  const cells = rasterFrame([read], 1500, 50, 16, '1.2k in · 300 out')
  // 12 bytes per cell, base64-encoded.
  expect(cells.length).toBe(Math.ceil((50 * 16 * 12) / 3) * 4)
  const svg = svgFrame([read], 1500, '1.2k in · 300 out')
  expect(svg).toContain('<path')
  expect(svgFrame([read], 1000 + LIFE * 2, '')).not.toContain('<path')
})

test('pixel frames are the size asked, transparent where nothing is drawn', () => {
  const { w, h } = pixelSize(50, 30)
  expect(w * h <= 120_000).toBe(true)
  const t0 = Date.now()
  const bytes = Uint8Array.from(atob(pixelFrame([{ ...read, status: 'run' }], 1500, w, h, '1.2K IN')), c => c.charCodeAt(0))
  expect(Date.now() - t0 < 200).toBe(true)
  expect(bytes.length).toBe(w * h * 4)
  expect(bytes[3]).toBe(0) // the corner is transparent
  expect(bytes.some((v, i) => i % 4 === 3 && v === 255)).toBe(true)
})
