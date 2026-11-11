import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Entry, Kind, Status, Totals } from '../types'
import { rasterFrame, svgFrame, timing } from './graph'
import { pixelFrame, pixelSize } from './pixels'

const PANE = 'activity-feed'
const MAX = 300
// Bump the tag when Entry's fields change: older stored values are then ignored.
const entries = atom({ plugin: 'activity-feed', key: 'entries' } as const, [], {
  shape: 'entries-1',
})
// agentId -> subagent type, so a subagent's own tool calls are labelled.
const agents = atom({ plugin: 'activity-feed', key: 'agents' } as const, {})
const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
const totals = atom({ plugin: 'activity-feed', key: 'totals' } as const, ZERO, { shape: 'totals-1' })

export const fmt = (n: number) =>
  n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`
const inTokens = (u: ModelUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
const usageText = (u: ModelUsage) =>
  ` · in ${fmt(inTokens(u))} (cached ${fmt(u.cache_read_input_tokens)}) · out ${fmt(u.output_tokens)}`
const hubText = (t: Totals) => `${fmt(t.input + t.cacheRead + t.cacheWrite)} in · ${fmt(t.output)} out`

// How the terminal draws the graph: pixels where it can show images, else braille.
const mode = atom({ plugin: 'activity-feed', key: 'mode' } as const, 'auto')

// What the terminal pane has mounted, for the animation timer. Transient on
// purpose: a reload re-renders and sets it again.
type Mounted = { kind: 'raster'; cols: number; rows: number } | { kind: 'image'; w: number; h: number }
let mounted: Mounted | undefined
// Set when this terminal showed the Image's alt text instead of pixels.
let imagesFail = false
let didWarnTmux = false
let wasLive = false
let isTicking = false
let frame = 0
const tick = async ($: EngineInterface) => {
  if (mounted === undefined || isTicking) return
  // Pixel frames are big: 15fps for them, 30 for braille.
  if (mounted.kind === 'image' && frame++ % 2 === 1) return
  isTicking = true
  try {
    const now = Date.now()
    const list = await read($, entries)
    const isLive = list.some(x => timing(x, now).alpha > 0)
    // One more frame after the last edge fades, to clear it; then stay idle.
    if (!isLive && !wasLive) return
    wasLive = isLive
    const sub = hubText(await read($, totals))
    const m = mounted
    const r =
      m.kind === 'raster'
        ? await $.ui.blit({ requestId: PANE, key: 'graph', cells: rasterFrame(list, now, m.cols, m.rows, sub) })
        : await $.ui.blit({ requestId: PANE, key: 'graph', source: { rgba: pixelFrame(list, now, m.w, m.h, sub), width: m.w, height: m.h } })
    if (r.deny === undefined) return
    mounted = undefined
    if (m.kind === 'image' && !/^no-surface|not mounted|size/i.test(r.deny)) {
      imagesFail = true
      if (r.fix === 'tmux-passthrough' && !didWarnTmux) {
        didWarnTmux = true
        $.ui.toast('Activity: tmux is hiding images. Run `tmux set -g allow-passthrough on; tmux set -g focus-events on`.')
      }
      $.ui.invalidate('ui.render')
    }
  } finally {
    isTicking = false
  }
}

// Claude's own memory: auto-memory and rules under ~/.claude, and the
// instruction files it loads. Not any folder that happens to be named memory.
const MEMORY_PATH = /(\/\.claude\/(.*\/)?(memory|rules)\/|(^|\/)(CLAUDE|MEMORY|CONTEXT|AGENTS)(\.local)?\.md$)/
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// Logged by their own events (agent.spawn, skill.prompt) with better detail.
const SKIP = new Set(['Agent', 'Task', 'Skill'])

type $ = EngineInterface

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// Writes go through one queue so a hook never waits on them before calling
// next (the tool or model request starts at once) and they still land in order.
let queue: Promise<unknown> = Promise.resolve()
const later = (fn: () => Promise<unknown>) => {
  queue = queue.then(fn).catch(() => undefined)
}

const agentLabel = async ($: $, agentId: string | undefined) => {
  if (agentId === undefined) return undefined
  const map = await read($, agents)
  return map[agentId] ?? agentId.slice(0, 6)
}

type NewEntry = Omit<Entry, 'at' | 'agent'> & { agentId?: string }
const add = ($: $, { agentId, ...entry }: NewEntry) => {
  const at = Date.now()
  later(async () => {
    const agent = await agentLabel($, agentId)
    await update($, entries, list => [...list, { at, agent, ...entry }].slice(-MAX))
  })
}

const settle = ($: $, match: (x: Entry) => boolean, status: Status, suffix = '') => {
  const end = Date.now()
  later(() =>
    update($, entries, list =>
      list.map(x => (match(x) && x.status === 'run' ? { ...x, status, ms: end - x.at, detail: x.detail + suffix } : x)),
    ),
  )
}
const finish = ($: $, id: string, status: Status, suffix = '') => settle($, x => x.id === id, status, suffix)

/** The one argument that best says what a tool call is about. */
export const summarize = (args: Record<string, unknown>): string => {
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return oneLine(v)
  }
  return ''
}

/** Which kind of activity a tool call is, and its label in the feed. */
export const classify = (tool: string, args: Record<string, unknown>): { kind: Kind; label: string } => {
  const path = [args.file_path, args.notebook_path, args.path].find(v => typeof v === 'string') as string | undefined
  if (path !== undefined && MEMORY_PATH.test(path))
    return { kind: 'memory', label: WRITES.has(tool) ? 'memory write' : 'memory read' }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    return { kind: /memory/i.test(name) ? 'memory' : 'mcp', label: `${server}:${name}` }
  }
  return { kind: 'tool', label: tool }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'activity',
      description: 'Open the live activity pane',
      argumentHint: '[clear | pixels | braille | auto]',
    })
    if (e.isInteractive) {
      void $.ui.open({ id: PANE, title: 'Activity' })
      $.clock.every(33, () => void tick($))
    }
    return next(e)
  })

  on('command.run', { command: 'activity' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      later(() => update($, entries, () => []))
      later(() => update($, totals, () => ZERO))
      await queue
      return { text: 'Activity cleared.' }
    }
    if (arg === 'pixels' || arg === 'braille' || arg === 'auto') {
      imagesFail = false
      await update($, mode, () => arg)
      await $.ui.open({ id: PANE, title: 'Activity' })
      return { text: `Activity graph: ${arg}.` }
    }
    if (arg !== '') return { text: 'Usage: /activity [clear | pixels | braille | auto]' }
    await $.ui.open({ id: PANE, title: 'Activity' })
    return { text: 'Activity pane opened.' }
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'activity')
      add($, { id: crypto.randomUUID(), kind: 'command', label: `/${e.command}`, detail: oneLine(e.args), status: 'ok' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined)
      add($, { id: crypto.randomUUID(), kind: 'prompt', label: e.isMeta ? 'prompt (hidden)' : 'prompt', detail: oneLine(e.text), status: 'ok' })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (SKIP.has(tool)) return next(e)
    const args = e as unknown as Record<string, unknown>
    const { kind, label } = classify(tool, args)
    const detail = summarize(args)
    const id = e.tool_use_id
    add($, { id, kind, label, detail, agentId: e.agentId, status: 'run' })
    $.ui.status(`▶ ${label} ${clip(detail, 50)}`)
    let status: Status = 'err'
    try {
      const ran = await next(e)
      status = ran.deny !== undefined ? 'deny' : ran.isError === true ? 'err' : 'ok'
      return ran
    } finally {
      finish($, id, status)
      $.ui.status(undefined)
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'allow')
      add($, {
        id: crypto.randomUUID(),
        kind: 'permission',
        label: `permission ${verdict.decision}`,
        detail: `${e.tool}${verdict.reason ? ` — ${oneLine(verdict.reason)}` : ''}`,
        agentId: e.agentId,
        status: verdict.decision === 'deny' ? 'deny' : 'ok',
      })
    return verdict
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const id = started.agentId ?? e.tool_use_id
    if (started.agentId !== undefined) later(() => update($, agents, map => ({ ...map, [id]: e.subagentType })))
    add($, { id, kind: 'agent', label: `agent ${e.subagentType}`, detail: oneLine(e.description), status: 'run' })
    return started
  })

  on('skill.prompt', async ($, e, next) => {
    add($, { id: crypto.randomUUID(), kind: 'skill', label: 'skill', detail: e.skill, status: 'ok' })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = `step:${e.turnId}:${e.index}`
    add($, { id, kind: 'model', label: 'model', detail: `${e.model} #${e.index}`, agentId: e.agentId, status: 'run' })
    let status: Status = 'err'
    try {
      const result = yield* next(e)
      status = 'ok'
      return result
    } finally {
      // An abandoned stream may never get here; turn.complete settles it then.
      finish($, id, status)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const tokens = u ? usageText(u) : ''
    // Session totals count subagents' tokens too; `turns` counts main-loop turns.
    // Anything of this turn still marked running ended with it (an interrupt).
    settle($, x => x.id.startsWith(`step:${e.turnId}:`), e.reason === 'answer' ? 'ok' : 'err')
    if (e.agentId === undefined && e.isAborted) settle($, x => x.kind !== 'agent', 'err')
    later(() => update($, totals, (t = ZERO) => ({
      input: t.input + (u?.input_tokens ?? 0),
      output: t.output + (u?.output_tokens ?? 0),
      cacheRead: t.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: t.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
      turns: t.turns + (e.agentId === undefined ? 1 : 0),
    })))
    if (e.agentId !== undefined) {
      // A subagent's run ended: close its spawn entry.
      finish($, e.agentId, e.isAborted || e.reason === 'error' ? 'err' : 'ok', tokens)
    } else {
      add($, {
        id: e.turnId,
        kind: 'turn',
        label: `turn ${e.reason}`,
        detail: `${(e.durationMs / 1000).toFixed(1)}s${tokens}`,
        status: e.reason === 'answer' ? 'ok' : 'err',
      })
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const id = crypto.randomUUID()
    add($, { id, kind: 'compact', label: 'compact', detail: String(e.trigger), agentId: e.agentId, status: 'run' })
    let status: Status = 'err'
    try {
      const done = await next(e)
      status = 'ok'
      return done
    } finally {
      finish($, id, status)
    }
  })

  on('session.receive', async ($, e, next) => {
    add($, { id: crypto.randomUUID(), kind: 'delivery', label: `delivery ${e.origin.kind}`, detail: oneLine(e.text), status: 'ok' })
    return next(e)
  })

  // Memory and instructions Claude Code loads by itself, with no tool call.
  on('prompt.section', { name: 'memory' }, async ($, e, next) => {
    const done = await next(e)
    if (done.text) add($, { id: crypto.randomUUID(), kind: 'memory', label: 'memory load', detail: `system prompt · ${fmt(done.text.length)} chars`, status: 'ok' })
    return done
  })

  on('prompt.attachment', async ($, e, next) => {
    const done = await next(e)
    // Hook-added context is logged at session.append, with the hook's event name.
    if (e.origin.kind === 'engine' && done.text !== null) {
      const isMemory = e.type === 'nested_memory'
      add($, {
        id: crypto.randomUUID(),
        kind: isMemory ? 'memory' : 'context',
        label: isMemory ? 'memory load' : e.type.replace(/_/g, ' '),
        detail: oneLine(done.text).slice(0, 120),
        agentId: e.agentId,
        status: 'ok',
      })
    }
    return done
  })

  // Settings hooks that put context into the conversation.
  on('session.append', { door: 'hook-context' }, async ($, e, next) => {
    const stored = await next(e)
    const event = e.origin.kind === 'hook' ? e.origin.event : 'hook'
    const text = e.message.content.map(b => ('text' in b && typeof b.text === 'string' ? b.text : '')).join(' ')
    add($, { id: e.uuid, kind: 'hook', label: `hook ${event}`, detail: oneLine(text).slice(0, 120), agentId: e.agentId, status: 'ok' })
    return stored
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, entries)
    const t = await read($, totals)
    const now = Date.now()
    const width = Math.max(20, e.props.bodyColumns)
    const bodyRows = e.props.scroll.bodyRows
    const running = list.filter(x => x.status === 'run').length
    const header = `${t.turns} turns · ${hubText(t)} · ${fmt(t.cacheRead)} cached · ${running} running`

    let graph
    let used: number
    if (e.surface === 'terminal') {
      const { Raster, Image } = $.ui.resolve(e)
      const m = await read($, mode)
      const usePixels = m === 'pixels' || (m === 'auto' && !imagesFail)
      const cols = Math.min(usePixels ? 255 : 512, width)
      const rows = Math.max(8, Math.min(usePixels ? 255 : 256, bodyRows - (bodyRows >= 18 ? 7 : 1)))
      wasLive = true
      if (usePixels) {
        // Not `h`: that name is the JSX factory.
        const { w, h: ph } = pixelSize(cols, rows)
        mounted = { kind: 'image', w, h: ph }
        graph = (
          <Image
            key="graph"
            columns={cols}
            rows={rows}
            alt="Activity graph (this terminal shows no images: /activity braille)"
            source={{ rgba: pixelFrame(list, now, w, ph, hubText(t)), width: w, height: ph }}
          />
        )
      } else {
        mounted = { kind: 'raster', cols, rows }
        graph = <Raster key="graph" columns={cols} rows={rows} cells={rasterFrame(list, now, cols, rows, hubText(t))} />
      }
      used = rows + 1
    } else {
      const { Svg } = $.ui.resolve(e)
      graph = <Svg source={svgFrame(list, now, hubText(t))} alt={`Activity graph: ${running} events running`} />
      used = 18
    }
    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(0, bodyRows - used)

    return (
      <Box flexDirection="column">
        <Text dimColor>{clip(header, width)}</Text>
        {graph}
        {room > 0 && list.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {(room > 0 ? list.slice(-room) : []).map(x => (
          <Text color={color(x)} dimColor={x.kind === 'model' && x.status !== 'run'}>
            {clip(row(x), width)}
          </Text>
        ))}
      </Box>
    )
  })
}

const GLYPH: Record<Status, string> = { run: '…', ok: '✓', err: '✗', deny: '⊘' }
const KIND_COLOR: Partial<Record<Kind, string>> = {
  memory: 'remember',
  agent: 'claude',
  skill: 'suggestion',
  mcp: 'ide',
  permission: 'permission',
  prompt: 'text',
  compact: 'planMode',
  hook: 'bashBorder',
}

const color = (x: Entry) =>
  x.status === 'err' ? 'error' : x.status === 'deny' ? 'warning' : KIND_COLOR[x.kind] ?? 'subtle'

const row = (x: Entry) => {
  const t = new Date(x.at).toTimeString().slice(0, 8)
  const who = x.agent ? `[${x.agent}] ` : ''
  const ms = x.ms !== undefined ? ` ${x.ms < 1000 ? `${x.ms}ms` : `${(x.ms / 1000).toFixed(1)}s`}` : ''
  return `${t} ${GLYPH[x.status]} ${who}${x.label}${x.detail ? ` ${x.detail}` : ''}${ms}`
}
