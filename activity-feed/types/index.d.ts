export type Kind =
  | 'prompt'
  | 'command'
  | 'turn'
  | 'model'
  | 'tool'
  | 'memory'
  | 'mcp'
  | 'agent'
  | 'skill'
  | 'permission'
  | 'compact'
  | 'delivery'
  | 'hook'
  | 'context'

export type Status = 'run' | 'ok' | 'err' | 'deny'

export type Entry = {
  id: string
  at: number
  kind: Kind
  label: string
  detail: string
  agent?: string
  status: Status
  ms?: number
}

export type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }

declare module 'claude-code' {
  interface PluginState {
    'activity-feed': { entries: Shaped<Entry[]>; agents: Record<string, string>; totals: Shaped<Totals>; mode: 'auto' | 'pixels' | 'braille' }
  }
}
