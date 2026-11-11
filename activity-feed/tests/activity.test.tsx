import { expect, test } from 'claude-code/testing'
import { classify } from '../hooks/activity'

const PANE = {
  plugin: 'activity-feed',
  component: 'Pane',
  requestId: 'activity-feed',
  props: {
    title: 'Activity',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('memory, mcp and plain tool calls show up classified', async ($, on) => {
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/x/.claude/projects/p/memory/MEMORY.md' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /memory read/ }))?.text).toContain('✓')
    expect((await ui.find({ type: 'Text', text: /Bash ls -la/ }))?.text).toContain('✓')
    await ui.unmount()
  }
})

test('only Claude memory counts as memory', async () => {
  expect(classify('Read', { file_path: '/repo/src/memory/alloc.c' }).kind).toBe('tool')
  expect(classify('Write', { file_path: '/u/.claude/projects/p/memory/x.md' }).label).toBe('memory write')
  expect(classify('Read', { file_path: '/repo/CLAUDE.md' }).kind).toBe('memory')
})

test('a tool call that fails is not left running', async ($, on) => {
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => {
    throw new Error('interrupted')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 9' }).catch(() => undefined)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /sleep 9/ }))?.text).toContain('✗')
  await ui.unmount()
})
