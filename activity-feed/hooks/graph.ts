// Pure drawing code: a session hub in the middle, touch-point nodes on an
// ellipse around it, one curved edge per recent event that grows in, stays lit
// while the event runs, then fades out over LIFE ms.
import type { Entry } from '../types'

export const LIFE = 6000
export const GROW = 400
const STUCK = 120_000 // a "running" entry older than this fades anyway

export type NodeKey =
  | 'model' | 'prompt' | 'command' | 'permission' | 'memory' | 'files' | 'shell'
  | 'tools' | 'web' | 'mcp' | 'delivery' | 'compact' | 'hook' | 'context' | 'agent' | 'skill'

// Clockwise from the top. Long labels sit on the sides, where rows are spaced widest.
export const NODES: readonly { key: NodeKey; label: string; rgb: number }[] = [
  { key: 'model', label: 'model', rgb: 0xd97757 },
  { key: 'prompt', label: 'prompt', rgb: 0x4ea1ff },
  { key: 'command', label: 'command', rgb: 0x8a8aff },
  { key: 'permission', label: 'permission', rgb: 0xe05050 },
  { key: 'memory', label: 'memory', rgb: 0xc070e0 },
  { key: 'files', label: 'files', rgb: 0x5fb85f },
  { key: 'shell', label: 'shell', rgb: 0xc9952a },
  { key: 'tools', label: 'tools', rgb: 0x8a8a8a },
  { key: 'web', label: 'web', rgb: 0x2aa3a3 },
  { key: 'mcp', label: 'mcp', rgb: 0x3fa0d0 },
  { key: 'delivery', label: 'delivery', rgb: 0x70c090 },
  { key: 'compact', label: 'compact', rgb: 0x7090b0 },
  { key: 'hook', label: 'hook', rgb: 0xb8862b },
  { key: 'context', label: 'context', rgb: 0x6f8fa0 },
  { key: 'agent', label: 'agent', rgb: 0xff7a45 },
  { key: 'skill', label: 'skill', rgb: 0xe060a0 },
]
const RGB = new Map(NODES.map(n => [n.key, n.rgb]))

const FILES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS'])
const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell'])
const WEB = new Set(['WebFetch', 'WebSearch'])
const INBOUND = new Set<NodeKey>(['prompt', 'command', 'delivery', 'hook', 'context'])

export const nodeOf = (x: Entry): NodeKey | undefined => {
  if (x.kind === 'turn') return undefined
  if (x.kind !== 'tool') return x.kind
  return FILES.has(x.label) ? 'files' : SHELL.has(x.label) ? 'shell' : WEB.has(x.label) ? 'web' : 'tools'
}

type P = { x: number; y: number }

export const layout = (w: number, h: number, padX: number, padY: number) => {
  const center = { x: w / 2, y: h / 2 }
  const rx = Math.max(1, w / 2 - padX)
  const ry = Math.max(1, h / 2 - padY)
  const pos = new Map<NodeKey, P & { cos: number }>()
  NODES.forEach((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / NODES.length
    pos.set(n.key, { x: center.x + Math.cos(a) * rx, y: center.y + Math.sin(a) * ry, cos: Math.cos(a) })
  })
  return { center, pos }
}

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export type Edge = { from: P; to: P; ctrl: P; rgb: number; node: NodeKey; grow: number; alpha: number; isRunning: boolean; seed: number }

/** Where an event is in its life: how far its edge has grown, how lit it still is. */
export const timing = (x: Entry, now: number) => {
  const isRunning = x.status === 'run' && now - x.at < STUCK
  const end = isRunning ? now : x.status === 'run' ? x.at + STUCK : x.at + (x.ms ?? 0)
  return {
    isRunning,
    grow: Math.min(1, Math.max(0, (now - x.at) / GROW)),
    alpha: Math.min(1, Math.max(0, 1 - (now - end) / LIFE)),
  }
}

export const edges = (list: readonly Entry[], now: number, L: ReturnType<typeof layout>): Edge[] =>
  list.slice(-80).flatMap(x => {
    const node = nodeOf(x)
    const to = node && L.pos.get(node)
    if (!node || !to) return []
    const t = timing(x, now)
    if (t.alpha <= 0) return []
    // A subagent's own events start at the agent node, not the session.
    let from: P = x.agent && node !== 'agent' ? L.pos.get('agent')! : L.center
    let end: P = to
    if (INBOUND.has(node)) [from, end] = [end, from]
    const seed = hash(x.id)
    const bend = ((seed % 1000) / 1000 - 0.5) * 0.7
    const dx = end.x - from.x
    const dy = end.y - from.y
    const ctrl = { x: (from.x + end.x) / 2 - dy * bend, y: (from.y + end.y) / 2 + dx * bend }
    return [{ from, to: end, ctrl, rgb: RGB.get(node)!, node, seed, ...t }]
  })

const at = (e: Edge, t: number): P => {
  const u = 1 - t
  return {
    x: u * u * e.from.x + 2 * u * t * e.ctrl.x + t * t * e.to.x,
    y: u * u * e.from.y + 2 * u * t * e.ctrl.y + t * t * e.to.y,
  }
}

// ---- terminal: braille dots in a Raster ----------------------------------

const DEFAULT = 0x01000000
// Mid greys: readable on dark and light terminals alike.
const DIM = 0x808080
const SUB = 0x8c8c8c
const MID = 0x808080
// Braille dot bits by [row 0..3][col 0..1] inside one cell.
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const

// Fades toward mid grey rather than black, so a fading edge recedes on any background.
const shade = (rgb: number, k: number) => {
  const mix = (sh: number) => Math.round(((rgb >> sh) & 255) * k + ((MID >> sh) & 255) * (1 - k))
  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

const toBase64 = (words: Uint32Array) => {
  const bytes = new Uint8Array(words.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** One Raster frame, `cols` x `rows` cells, base64 as RasterProps.cells wants. */
export const rasterFrame = (list: readonly Entry[], now: number, cols: number, rows: number, sub: string): string => {
  const W = cols * 2
  const H = rows * 4
  const L = layout(W, H, 12, 4)
  const mask = new Uint8Array(cols * rows)
  const fg = new Uint32Array(cols * rows).fill(DEFAULT)
  const lit = new Set<NodeKey>()

  for (const e of edges(list, now, L)) {
    lit.add(e.node)
    const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) + 1
    const steps = Math.ceil(len * 1.3)
    const color = shade(e.rgb, 0.35 + 0.65 * e.alpha)
    // Trim the ends so lines stop short of the labels they join.
    const t0 = 0.1
    const t1 = 0.1 + 0.8 * e.grow
    for (let i = 0; i <= steps; i++) {
      // Fading = fewer dots; each dot keeps its own threshold so nothing flickers.
      if (e.alpha < 0.6 && ((i * 7 + e.seed) % 10) / 10 > e.alpha / 0.6) continue
      const p = at(e, t0 + (t1 - t0) * (i / steps))
      const px = Math.round(p.x)
      const py = Math.round(p.y)
      if (px < 0 || py < 0 || px >= W || py >= H) continue
      const cell = (py >> 2) * cols + (px >> 1)
      mask[cell]! |= BIT[py & 3]![px & 1]!
      fg[cell] = color
    }
  }

  const out = new Uint32Array(cols * rows * 3)
  for (let i = 0; i < cols * rows; i++) {
    out[i * 3] = mask[i] ? 0x2800 + mask[i]! : 0x20
    out[i * 3 + 1] = fg[i]!
    out[i * 3 + 2] = DEFAULT
  }
  const text = (col: number, row: number, s: string, color: number) => {
    if (row < 0 || row >= rows) return
    const c0 = Math.max(0, Math.min(cols - s.length, Math.round(col)))
    for (let k = 0; k < s.length && c0 + k < cols; k++) {
      const i = (row * cols + c0 + k) * 3
      out[i] = s.charCodeAt(k)
      out[i + 1] = color
    }
  }
  for (const n of NODES) {
    const p = L.pos.get(n.key)!
    text(p.x / 2 - n.label.length / 2, Math.floor(p.y / 4), n.label, lit.has(n.key) ? n.rgb : DIM)
  }
  const cr = Math.floor(L.center.y / 4)
  text(cols / 2 - 3.5, cr, 'session', DEFAULT)
  text(cols / 2 - sub.length / 2, cr + 1, sub, SUB)
  return toBase64(out)
}

// ---- desktop / vscode / mobile: SVG with SMIL fades ---------------------

const hex = (rgb: number) => '#' + rgb.toString(16).padStart(6, '0')
const n1 = (v: number) => v.toFixed(1)
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

export const SVG_W = 480
export const SVG_H = 300

/** The graph as an SVG document. Each redraw restarts the animations from "now". */
export const svgFrame = (list: readonly Entry[], now: number, sub: string): string => {
  const L = layout(SVG_W, SVG_H, 70, 30)
  const list2 = edges(list, now, L)
  const lit = new Set(list2.map(e => e.node))
  const paths = list2.map(e => {
    const d = `M${n1(e.from.x)},${n1(e.from.y)} Q${n1(e.ctrl.x)},${n1(e.ctrl.y)} ${n1(e.to.x)},${n1(e.to.y)}`
    const fade = e.isRunning
      ? ''
      : `<animate attributeName="opacity" from="${e.alpha.toFixed(3)}" to="0" dur="${((e.alpha * LIFE) / 1000).toFixed(2)}s" fill="freeze"/>`
    const grow =
      e.grow < 1
        ? `<animate attributeName="stroke-dashoffset" from="${(1 - e.grow).toFixed(3)}" to="0" dur="${(((1 - e.grow) * GROW) / 1000).toFixed(2)}s" fill="freeze"/>`
        : ''
    return `<path d="${d}" fill="none" stroke="${hex(e.rgb)}" stroke-width="${e.isRunning ? 2.5 : 1.8}" stroke-linecap="round" opacity="${e.alpha.toFixed(3)}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - e.grow).toFixed(3)}">${grow}${fade}</path>`
  })
  const nodes = NODES.map(n => {
    const p = L.pos.get(n.key)!
    const on = lit.has(n.key)
    const anchor = p.cos > 0.3 ? 'start' : p.cos < -0.3 ? 'end' : 'middle'
    const lx = p.x + (anchor === 'start' ? 10 : anchor === 'end' ? -10 : 0)
    const ly = anchor === 'middle' ? p.y + (p.y < SVG_H / 2 ? -10 : 18) : p.y + 4
    return (
      `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${on ? 6 : 4.5}" fill="${hex(n.rgb)}" opacity="${on ? 1 : 0.35}"/>` +
      `<text x="${n1(lx)}" y="${n1(ly)}" text-anchor="${anchor}" fill="${on ? hex(n.rgb) : '#888'}">${n.label}</text>`
    )
  })
  const c = L.center
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">` +
    paths.join('') +
    nodes.join('') +
    `<circle cx="${c.x}" cy="${c.y}" r="34" fill="#8881" stroke="#888" stroke-width="1"/>` +
    `<text x="${c.x}" y="${c.y - 2}" text-anchor="middle" fill="#888" font-size="12" font-weight="600">session</text>` +
    `<text x="${c.x}" y="${c.y + 13}" text-anchor="middle" fill="#888" font-size="9">${esc(sub)}</text>` +
    `</svg>`
  )
}
