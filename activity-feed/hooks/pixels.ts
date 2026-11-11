// Real-pixel version of the graph for terminals with kitty graphics (Ghostty,
// kitty) or iTerm2 inline images: RGBA with a transparent background, so it
// sits on any theme. Glowing anti-aliased curves, true alpha fades, and a
// pulse travelling along every edge whose event is still running.
import type { Entry } from '../types'
import { NODES, edges, layout } from './graph'

// Pixels per terminal cell, before the budget below scales it down.
const PX_W = 8
const PX_H = 16
// ponytail: every frame crosses $ as base64 RGBA (~0.6 MB at this budget, 15fps
// while live). If that ever shows up as lag, render in a helper process and
// hand the Image a `file`/`shm` source instead, so no pixel crosses $.
const MAX_PIXELS = 120_000

/** The pixel size an Image of `cols` x `rows` cells is drawn at. */
export const pixelSize = (cols: number, rows: number) => {
  let w = cols * PX_W
  let h = rows * PX_H
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)))
  w = Math.max(1, Math.min(2048, Math.round(w * k)))
  h = Math.max(1, Math.min(2048, Math.round(h * k)))
  return { w, h }
}

// ---- 5x7 bitmap font: uppercase, digits, a few marks ----------------------

const GLYPHS: Record<string, string> = {
  A: '.###. #...# #...# ##### #...# #...# #...#', B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.', D: '####. #...# #...# #...# #...# #...# ####.',
  E: '##### #.... #.... ####. #.... #.... #####', F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####', H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.', J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#', L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#', N: '#...# #...# ##..# #.#.# #..## #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.', P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#', R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.', T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.', V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.', X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..', Z: '##### ....# ...#. ..#.. .#... #.... #####',
  '0': '.###. #...# #..## #.#.# ##..# #...# .###.', '1': '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  '2': '.###. #...# ....# ...#. ..#.. .#... #####', '3': '####. ....# ....# .###. ....# ....# ####.',
  '4': '...#. ..##. .#.#. #..#. ##### ...#. ...#.', '5': '##### #.... ####. ....# ....# #...# .###.',
  '6': '.###. #.... #.... ####. #...# #...# .###.', '7': '##### ....# ...#. ..#.. .#... .#... .#...',
  '8': '.###. #...# #...# .###. #...# #...# .###.', '9': '.###. #...# #...# .#### ....# ....# .###.',
  '.': '..... ..... ..... ..... ..... .##.. .##..', '·': '..... ..... ..... .##.. .##.. ..... .....',
  '-': '..... ..... ..... ##### ..... ..... .....', ':': '..... .##.. .##.. ..... .##.. .##.. .....',
}
const FONT = new Map(Object.entries(GLYPHS).map(([c, rows]) => [c, rows.split(' ')]))

// ---- canvas: premultiplied float RGBA, "over" compositing -----------------

class Canvas {
  readonly r: Float32Array
  readonly g: Float32Array
  readonly b: Float32Array
  readonly a: Float32Array
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.r = new Float32Array(w * h)
    this.g = new Float32Array(w * h)
    this.b = new Float32Array(w * h)
    this.a = new Float32Array(w * h)
  }

  /** Composites `rgb` at coverage `alpha` (0..1) over pixel (x, y). */
  put(x: number, y: number, rgb: number, alpha: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || alpha <= 0.002) return
    const i = y * this.w + x
    const k = 1 - alpha
    this.r[i] = this.r[i]! * k + ((rgb >> 16) & 255) * alpha
    this.g[i] = this.g[i]! * k + ((rgb >> 8) & 255) * alpha
    this.b[i] = this.b[i]! * k + (rgb & 255) * alpha
    this.a[i] = this.a[i]! * k + alpha
  }

  /** A soft round dot: solid to `core`, gaussian falloff to `radius`. */
  dot(cx: number, cy: number, radius: number, core: number, rgb: number, alpha: number) {
    const spread = Math.max(0.5, radius - core) / 2
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++)
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (d > radius) continue
        const cover = d <= core ? 1 : Math.exp(-(((d - core) / spread) ** 2) / 2)
        this.put(x, y, rgb, alpha * cover)
      }
  }

  text(s: string, x: number, y: number, scale: number, rgb: number, alpha: number) {
    let cx = Math.round(x)
    const top = Math.round(y)
    for (const ch of s.toUpperCase()) {
      const rows = FONT.get(ch)
      rows?.forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx++)
          if (row[rx] === '#')
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++) this.put(cx + rx * scale + dx, top + ry * scale + dy, rgb, alpha)
      })
      cx += 6 * scale
    }
  }

  /** Straight-alpha RGBA bytes, base64, as ImageSource's `rgba` takes them. */
  toBase64(): string {
    const out = new Uint8Array(this.w * this.h * 4)
    for (let i = 0; i < this.w * this.h; i++) {
      const a = this.a[i]!
      if (a <= 0) continue
      out[i * 4] = Math.min(255, this.r[i]! / a)
      out[i * 4 + 1] = Math.min(255, this.g[i]! / a)
      out[i * 4 + 2] = Math.min(255, this.b[i]! / a)
      out[i * 4 + 3] = Math.min(255, a * 255)
    }
    const native = (out as unknown as { toBase64?: () => string }).toBase64
    if (native) return native.call(out)
    let s = ''
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000))
    return btoa(s)
  }
}

const GREY = 0x808080
const textWidth = (s: string, scale: number) => s.length * 6 * scale - scale

/** One RGBA frame of the graph, `w` x `h` pixels, base64. */
export const pixelFrame = (list: readonly Entry[], now: number, w: number, h: number, sub: string): string => {
  const c = new Canvas(w, h)
  const scale = Math.max(1, Math.round(h / 260))
  const longest = Math.max(...NODES.map(n => textWidth(n.label, scale)))
  const L = layout(w, h, longest / 2 + 4, 12 * scale + 6)
  const live = edges(list, now, L)
  const lit = new Set(live.map(e => e.node))
  const isBusy = live.some(e => e.isRunning)
  const hub = L.center
  const r = 22 * scale
  // Edges stop at the hub's ring and skip the token line under it, so both stay legible.
  const subW = textWidth(sub, scale) / 2 + 3 * scale
  const subTop = hub.y + r + 3 * scale
  const isInHub = (p: { x: number; y: number }) =>
    Math.hypot(p.x - hub.x, p.y - hub.y) < r + 3 ||
    (Math.abs(p.x - hub.x) < subW && p.y > subTop && p.y < subTop + 11 * scale)

  for (const e of live) {
    const at = (t: number) => {
      const u = 1 - t
      return {
        x: u * u * e.from.x + 2 * u * t * e.ctrl.x + t * t * e.to.x,
        y: u * u * e.from.y + 2 * u * t * e.ctrl.y + t * t * e.to.y,
      }
    }
    const len = Math.hypot(e.ctrl.x - e.from.x, e.ctrl.y - e.from.y) + Math.hypot(e.to.x - e.ctrl.x, e.to.y - e.ctrl.y)
    const steps = Math.max(8, Math.ceil(len / 0.8))
    const t1 = 0.08 + 0.84 * e.grow
    const width = e.isRunning ? 1.6 : 1.1
    for (let i = 0; i <= steps; i++) {
      const p = at(0.08 + (t1 - 0.08) * (i / steps))
      if (isInHub(p)) continue
      if (i % 4 === 0) c.dot(p.x, p.y, 5 * scale, 0, e.rgb, 0.065 * e.alpha) // glow
      c.dot(p.x, p.y, width + 1, width * 0.5, e.rgb, 0.55 * e.alpha) // core
    }
    const p = at(0.08 + (t1 - 0.08) * ((now / 900 + (e.seed % 97) / 97) % 1))
    if (e.isRunning && !isInHub(p)) {
      // A pulse travelling along the edge while its event runs.
      c.dot(p.x, p.y, 6 * scale, 1.5 * scale, e.rgb, 0.9)
      c.dot(p.x, p.y, 2 * scale, 0.8 * scale, 0xffffff, 0.7)
    }
  }

  for (const n of NODES) {
    const p = L.pos.get(n.key)!
    const on = lit.has(n.key)
    if (on) c.dot(p.x, p.y, 9 * scale, 0, n.rgb, 0.35)
    c.dot(p.x, p.y, 3.5 * scale, 2.2 * scale, on ? n.rgb : GREY, on ? 1 : 0.5)
    const tw = textWidth(n.label, scale)
    const ty = p.y < h / 2 ? p.y - 13 * scale : p.y + 6 * scale
    c.text(n.label, Math.max(0, Math.min(w - tw, p.x - tw / 2)), ty, scale, on ? n.rgb : GREY, on ? 1 : 0.8)
  }

  const pulse = isBusy ? 0.5 + 0.5 * Math.sin(now / 300) : 0
  c.dot(hub.x, hub.y, r * 1.6, r * 0.9, 0xd97757, 0.08 + 0.12 * pulse)
  for (let a = 0; a < Math.PI * 2; a += 0.6 / r) c.dot(hub.x + Math.cos(a) * r, hub.y + Math.sin(a) * r, 1.6, 0.6, GREY, 0.8)
  c.text('session', hub.x - textWidth('session', scale) / 2, hub.y - 3.5 * scale, scale, GREY, 1)
  c.text(sub, hub.x - textWidth(sub, scale) / 2, hub.y + r + 5 * scale, scale, GREY, 0.85)
  return c.toBase64()
}
