import { expect, mock, test } from 'claude-code/testing'

// The whole plugin on a mocked engine. Ticks run every minute from session start; turns happen
// at the start time, so the tick after `idle(n)` sits exactly n minutes after the last request.

const MIN = 60_000
// Monday 2026-11-02 09:00 local
const MON_9 = new Date(2026, 10, 2, 9, 0).getTime()
const HOURS = { start: 8, end: 18, days: [1, 2, 3, 4, 5] }

type Opts = {
  now?: number
  env?: Record<string, string>
  store?: Record<string, unknown>
  id?: string
  draft?: { text: string }
  rejectPing?: boolean
}

function world(on: any, opts: Opts = {}) {
  const w = { draft: null as unknown as { text: string }, store: null as unknown as Map<string, unknown>, pings: [] as string[], status: [] as (string | undefined)[], toasts: [] as string[] }
  const clock = mock.clock(on, { now: opts.now ?? MON_9 })
  // An inspectable store (mock.store's contents are not readable from the test).
  const store = new Map<string, unknown>(Object.entries(opts.store ?? { config: { hours: HOURS } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { HOME: '/home/t', ...(opts.env ?? {}) })
  const draft = opts.draft ?? { text: '' }
  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: opts.id ?? 'sess-1' }))
  on('state.set', async (_: any, e: any, next: any) => {
    const r = await next(e)
    if (e.key === 'line' && typeof e.value === 'string') w.status.push(e.value.replace(/^keepalive: /, ''))
    return r
  })
  on('ui.toast', (_: any, e: any) => { w.toasts.push(e.text); return { value: undefined } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => {
    if (e.origin?.kind === 'plugin') {
      w.pings.push(e.text)
      if (opts.rejectPing) throw new Error('refused')
    }
    return { text: e.text }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.text ?? '' }))
  on('session.compact', (_: any, e: any) => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  w.store = store
  w.draft = draft
  const idle = (minutes: number) => clock.advance(minutes * MIN)
  return { w, clock, idle }
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const cmd = async ($: any, args: string): Promise<string> => ((await $.command.run({ command: 'keepalive', args })) as any).text
const turn = async ($: any, agentId?: string) => {
  await $.turn.start({ turnId: 't', text: 'hi', agentId })
  await $.turn.complete({ turnId: 't', reason: 'end_turn', text: 'ok', answer: 'ok', agentId })
}

/** Asserts the first ping lands exactly at `atIdle` minutes: none a minute before. */
async function expectPingAt($: any, w: { pings: string[] }, idle: (m: number) => Promise<void>, atIdle: number) {
  await turn($)
  await idle(atIdle - 1)
  expect(w.pings.length).toBe(0)
  await idle(1)
  expect(w.pings.length).toBe(1)
}

// --- command and status line ---

test('command: on / off / status, and the status line follows', async ($, on) => {
  const { w } = world(on)
  await start($)
  expect(w.status.at(-1)).toBe('OFF · ⏰ Mon-Fri 8 am-6 pm')
  expect(await cmd($, 'on')).toBe('Keepalive is ON for this session.')
  expect(w.status.at(-1)).toBe('ON · ⏰ Mon-Fri 8 am-6 pm')
  expect(await cmd($, 'off')).toContain('OFF for this session')
  expect(w.status.at(-1)).toBe('OFF (manual) · ⏰ Mon-Fri 8 am-6 pm')
  expect(((w.store.get('session:sess-1') as any)?.mode)).toBe('off-manual')
})

test('command: bare /keepalive toggles this session; --global alone shows help', async ($, on) => {
  const { w } = world(on)
  await start($)
  expect(await cmd($, '')).toBe('Keepalive is ON for this session.') // none -> on
  expect(await cmd($, '  ')).toContain('OFF for this session') // on -> off-manual
  expect(w.status.at(-1)).toBe('OFF (manual) · ⏰ Mon-Fri 8 am-6 pm')
  expect(await cmd($, '')).toBe('Keepalive is ON for this session.') // off-manual -> on
  expect(await cmd($, '--global')).toContain('Usage: /keepalive')
})

test('command: setup, --global on/off, bad margins', async ($, on) => {
  const { w } = world(on, { store: {} })
  await start($)
  expect(await cmd($, 'setup 8 18 1-5')).toBe('Working hours set: Mon-Fri 8 am-6 pm.')
  expect(await cmd($, 'setup 18 8')).toContain('usage')
  expect(await cmd($, 'on --global')).toContain('default is ON')
  expect((w.store.get('config') as any).globalOn).toBe(true)
  expect(await cmd($, 'off --global')).toContain('default is OFF')
  expect((w.store.get('config') as any).globalOn).toBe(false)
  for (const bad of ['0', '60', 'x', '']) expect(await cmd($, `margin ${bad}`)).toContain('usage')
})

// --- margin ---

test('margin: 2 min by default -> ping at exactly 58 min idle, once', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'on')
  await expectPingAt($, w, idle, 58)
  await idle(5)
  expect(w.pings.length).toBe(1)
})

test('margin: /keepalive margin changes when the ping lands', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  expect(await cmd($, 'margin 10')).toContain('10 min')
  await cmd($, 'on')
  await expectPingAt($, w, idle, 50)
})

test('margin: commands that save config keep the stored margin', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'margin 5')
  await cmd($, 'setup 8 18 1-5')
  await cmd($, 'on --global')
  expect((w.store.get('config') as any).marginMin).toBe(5)
  await cmd($, 'on')
  await expectPingAt($, w, idle, 55)
})

test('margin: no ping storm on the 5 min cache (margin capped at half)', async ($, on) => {
  const { w, idle } = world(on, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
  await start($)
  await cmd($, 'margin 16')
  await cmd($, 'on')
  await turn($)
  await idle(2)
  expect(w.pings.length).toBe(0)
  await idle(1)
  expect(w.pings.length).toBe(1)
})

// --- defaults ---

test('defaults: off out of the box, Mon-Fri 9 am-5 pm', async ($, on) => {
  const { w, idle } = world(on, { store: {} })
  await start($)
  expect(w.status.at(-1)).toBe('OFF · ⏰ Mon-Fri 9 am-5 pm')
  await turn($)
  await idle(70)
  expect(w.pings.length).toBe(0)
})

// --- when a ping may happen ---

test('ping: none while off; none while a main turn is running; subagent turns do not count', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await turn($)
  await idle(70)
  expect(w.pings.length).toBe(0) // off

  await cmd($, 'on')
  await turn($)
  await $.turn.start({ turnId: 'long', text: 'work' }) // main turn still running
  await idle(59)
  expect(w.pings.length).toBe(0)
  await $.turn.complete({ turnId: 'long', reason: 'end_turn', text: '', answer: '' })

  await turn($, 'sub-1') // a subagent's turn neither resets idle nor blocks
  await idle(58)
  expect(w.pings.length).toBe(1)
})

test('ping: a refused ping is not retried every minute, and the user is told', async ($, on) => {
  const { w, idle } = world(on, { rejectPing: true })
  await start($)
  await cmd($, 'on')
  await turn($)
  await idle(59)
  expect(w.pings.length).toBe(1)
  expect(w.toasts.some(t => t.includes('could not be sent'))).toBe(true)
})

test('ping: a compaction counts as a request and restarts the idle clock', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'on')
  await turn($)
  await idle(30)
  await $.session.compact({ messages: [{ role: 'user', text: 'long talk', toolUses: [] }] })
  await idle(57) // 87 min after the turn, 57 after the compaction
  expect(w.pings.length).toBe(0)
  await idle(1)
  expect(w.pings.length).toBe(1)
})

test('ping: the plugin\'s own ping is not a user message (does not resume off-scheduled)', async ($, on) => {
  const { w, idle } = world(on, { now: new Date(2026, 10, 2, 17, 0).getTime() })
  await start($)
  await cmd($, 'on')
  await turn($)
  await idle(61) // 18:01: cut off
  expect(((w.store.get('session:sess-1') as any)?.mode)).toBe('off-scheduled')
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } })
  expect(((w.store.get('session:sess-1') as any)?.mode)).toBe('off-scheduled')
})

test('status line shows the countdown', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'on')
  await turn($)
  await idle(15)
  expect(w.status.at(-1)).toContain('cache 45/60m ping in 43m')
})

test('ping: an idle session gets exactly one ping, not one per hour', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'on')
  await turn($)
  await idle(58)
  expect(w.pings.length).toBe(1)
  // the ping's own turn, as the engine runs it
  await $.turn.start({ turnId: 'p', text: w.pings[0] })
  await $.turn.complete({ turnId: 'p', reason: 'answer', text: 'ok', answer: 'ok' })
  await idle(5 * 60)
  expect(w.pings.length).toBe(1)
  // the person acts: armed again
  await turn($)
  await idle(58)
  expect(w.pings.length).toBe(2)
})

test('ping: waits while the person is typing, retries next minute', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'on')
  await turn($)
  w.draft.text = 'half a thou'
  await idle(58)
  expect(w.pings.length).toBe(0)
  w.draft.text = ''
  await idle(1)
  expect(w.pings.length).toBe(1)
})

test('working: an interrupted turn clears it', async ($, on) => {
  const { w, idle } = world(on)
  await start($)
  await cmd($, 'on')
  await $.turn.start({ turnId: 'x', text: 'work' })
  await $.turn.complete({ turnId: 'x', reason: 'aborted', text: '', answer: '' })
  await idle(58)
  expect(w.pings.length).toBe(1)
})

test('working: a turn end that never arrives stops blocking after the cache length', async ($, on) => {
  const { w, idle } = world(on, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
  await start($)
  await cmd($, 'on')
  await turn($)
  await idle(2)
  await $.turn.start({ turnId: 'stuck', text: 'work' })
  await idle(1) // 3 min idle: due, but working
  expect(w.pings.length).toBe(0)
  await idle(5) // stuck longer than the cache: reset; the cache has expired, so re-arm on the next turn
  await turn($)
  await idle(3)
  expect(w.pings.length).toBe(1)
})

// --- schedule ---

test('schedule: 18:00 cutoff, toast, and a message next morning turns it back on', async ($, on) => {
  const { w, clock } = world(on, { now: new Date(2026, 10, 2, 17, 50).getTime() })
  await start($)
  await cmd($, 'on')
  await clock.advance(11 * MIN)
  expect(w.status.at(-1)).toBe('OFF (schedule) · ⏰ Mon-Fri 8 am-6 pm')
  expect(w.toasts).toContain('Keepalive turned off by schedule.')
  await clock.set(new Date(2026, 10, 3, 8, 30).getTime())
  await $.prompt.submit({ text: 'good morning' })
  expect(((w.store.get('session:sess-1') as any)?.mode)).toBe('on')
})

// --- resume and store ---

test('resume: state saved under the transcript id comes back; old entries are pruned', async ($, on) => {
  const old = MON_9 - 15 * 24 * 60 * MIN
  const { w } = world(on, {
    id: 'sess-9',
    store: {
      config: { hours: HOURS },
      'session:sess-9': { mode: 'on', onSince: MON_9, lastRequestAt: null, pingedFor: null, savedAt: MON_9 },
      'session:old': { mode: 'on', savedAt: old },
      'session:nodate': { mode: 'on' },
      'session:recent': { mode: 'off-manual', savedAt: MON_9 - MIN },
    },
  })
  await start($)
  expect(((w.store.get('session:sess-9') as any)?.mode)).toBe('on')
  const keys = [...w.store.keys()]
  expect(keys).not.toContain('session:old')
  expect(keys).not.toContain('session:nodate')
  expect(keys).toContain('session:recent')
  expect(keys).toContain('session:sess-9')
})

test('resume: every state change is saved for the next resume', async ($, on) => {
  const { w } = world(on, { id: 'sess-2' })
  await start($)
  await cmd($, 'off')
  expect((w.store.get('session:sess-2') as any).mode).toBe('off-manual')
})

test('command: view toggles placement; unknown input is handed to Claude', async ($, on) => {
  const { w, clock } = world(on)
  const sets: any[] = []
  on('config.set', (_: any, e: any) => { sets.push(e); return { value: e.value } })
  await start($)
  expect(await cmd($, 'view')).toContain('in the status line')
  expect(sets.map(s => [s.key, s.value])).toEqual([['keepalive.placement', 'status-line']])
  expect(await cmd($, 'keep it warm please')).toContain('asked Claude')
  expect(w.pings).toHaveLength(0)
  await clock.advance(100)
  expect(w.pings).toHaveLength(1)
  expect(w.pings[0]).toContain('/keepalive keep it warm please')
})
