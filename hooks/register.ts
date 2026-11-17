// keepalive: pings an idle session shortly before its prompt cache expires, inside working
// hours, toggled per session or as a default for new sessions. A one-minute clock compares
// idle time with the cache lifetime.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  DEFAULT_CONFIG, MINUTE_MS, NEW_SESSION,
  applySchedule, describe, readableHours, statusText, onUserMessage, parseHours, shouldPing, ttlMs,
} from './logic'
import type { Config, Session } from './logic'

const session = atom({ plugin: 'keepalive', key: 'session' } as const, NEW_SESSION, { shape: 'session-1' })
// When the running main turn started; null when idle.
const workingSince = atom({ plugin: 'keepalive', key: 'workingSince' } as const, null)
const line = atom({ plugin: 'keepalive', key: 'line' } as const, null)

const PING_TEXT = 'Keepalive ping to refresh the prompt cache. Reply with only "ok" and do nothing else.'

let isPinging = false
let pingTurnPending = false
let currentTurnIsPing = false

async function rawConfig($: EngineInterface): Promise<Partial<Config>> {
  return ((await $.store.get('config')) ?? {}) as Partial<Config>
}

async function config($: EngineInterface): Promise<Config> {
  return { ...DEFAULT_CONFIG, ...(await rawConfig($)) }
}

const KEEP_DAYS = 14

/** Writes the session state and mirrors it into $.store under the transcript id, so --resume/--continue gets it back. */
async function setSession($: EngineInterface, fn: (s: Session) => Session): Promise<void> {
  await update($, session, fn)
  try {
    const id = await $.session.id()
    await $.store.set(`session:${id}`, { ...(await read($, session)), savedAt: await $.clock.now() })
  } catch {}
}

/** On start: bring back a resumed session's state, and drop entries older than KEEP_DAYS. */
async function restoreSession($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.id()
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith('session:') || key === `session:${id}`) continue
      const v = (await $.store.get(key)) as { savedAt?: number } | undefined
      if (!v?.savedAt || now - v.savedAt > KEEP_DAYS * 24 * 60 * MINUTE_MS) await $.store.delete(key)
    }
    if ((await read($, session)).mode !== 'none') return
    const saved = (await $.store.get(`session:${id}`)) as (Session & { savedAt?: number }) | undefined
    if (saved?.mode) {
      const { savedAt: _, ...rest } = saved
      await update($, session, () => rest)
    }
  } catch {}
}

/** Keeps the row above the prompt current; a write redraws it only when the text changes. */
async function refreshStatus($: EngineInterface): Promise<void> {
  try {
    const [c, now, t] = [await config($), await $.clock.now(), await ttl($)]
    const text = `keepalive: ${statusText(await read($, session), c, now, t)}`
    if (text === (await read($, line))) return
    await update($, line, () => text)
    if (placement === 'status-line') $.ui.status(text.replace(/^keepalive: /, ''))
  } catch {}
}

async function ttl($: EngineInterface): Promise<number> {
  return ttlMs(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), await $.env.get('FORCE_PROMPT_CACHING_5M'))
}

let placement: 'above-prompt' | 'status-line' = 'above-prompt'

export const register: Register = (on, options) => {
  placement = options.placement === 'status-line' ? 'status-line' : 'above-prompt'
  // Its own row above the prompt: status-line entries swap places as plugins update them.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    if (!text || e.props.hasSurvey || placement === 'status-line') return next(e)
    const { Text } = $.ui.resolve(e)
    return h(Text, { dimColor: true }, text)
  })


  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined) // start clean; refresh puts it back when placement is status-line
    await update($, line, () => null)
    await $.command.register({
      name: 'keepalive',
      description: 'Prompt cache keepalive: on | off | setup <start> <end> [days] | margin <min> | view (toggle status line / above prompt); --global for the default',
      argumentHint: '[on|off|setup|margin|view] [--global]',
      immediate: true,
    })
    await restoreSession($)
    if (e.isInteractive) $.clock.every(MINUTE_MS, () => void tick($).catch(() => {}).then(() => refreshStatus($)))
    await refreshStatus($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurnIsPing = pingTurnPending || e.text === PING_TEXT
      pingTurnPending = false
      const at = await $.clock.now()
      await update($, workingSince, () => at)
    }
    return next(e)
  })

  on('turn.abort', async ($, e, next) => {
    const done = await next(e)
    await update($, workingSince, () => null)
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const at = await $.clock.now()
    const wasPing = currentTurnIsPing
    currentTurnIsPing = false
    await update($, workingSince, () => null)
    // A ping's own turn refreshes the cache but does not re-arm: only a turn the person started does.
    await setSession($, s => ({ ...s, lastRequestAt: at, pingedFor: wasPing ? at : s.pingedFor }))
    await refreshStatus($)
    return done
  })

  // A compaction is a request too: it refreshes the cache.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    try {
      const at = await $.clock.now()
      await setSession($, s => ({ ...s, lastRequestAt: at }))
    } catch {}
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'plugin') {
      try {
        const [c, now] = [await config($), await $.clock.now()]
        await setSession($, s => onUserMessage(s, c, now))
      } catch {}
    }
    return next(e)
  })

  on('command.run', { command: 'keepalive' }, async ($, e) => {
    const result = await runCommand($, e.args)
    await refreshStatus($)
    return result
  })
}

const HELP = 'Usage: /keepalive [on|off] [--global] | setup <start> <end> [days] | margin <min> | view   (view toggles status line / above the prompt)'

/** Toggles where the line shows: status line <-> row above the prompt. The engine reloads the plugin with the new option. */
async function toggleView($: EngineInterface): Promise<string> {
  const value = placement === 'status-line' ? 'above-prompt' : 'status-line'
  const { deny } = await $.config.set({ key: 'keepalive.placement', value })
  if (!deny) { placement = value; $.ui.status(undefined) } // the outgoing instance still refreshes once after this command; only it can clear its own entry
  return deny ? `Could not change the view: ${deny}` : `Now shown ${value === 'status-line' ? 'in the status line' : 'above the prompt'}.`
}

/** Input the command doesn't know goes to Claude, with the command's help, to act on. A command can't start a turn itself, so the prompt goes out just after it returns. */
async function askClaude($: EngineInterface, args: string, help: string): Promise<string> {
  const text = `I ran \`/keepalive ${args}\`, which the keepalive plugin did not recognise. Its help: ${help} Work out what I meant and do it (for example run the matching /keepalive subcommand for me by telling me which, or change its setting with \`claude plugin configure\`), or ask me if it is unclear.`
  $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
  return `Not a /keepalive subcommand; asked Claude what you meant.`
}

async function runCommand($: EngineInterface, rawArgs: string): Promise<{ text: string }> {
    const args = rawArgs.trim().split(/\s+/).filter(Boolean)
    const isGlobal = args.includes('--global')
    // bare /keepalive toggles this session: on -> off, anything else -> on
    const toggled = args.length === 0 ? ((await read($, session)).mode === 'on' ? 'off' : 'on') : 'help'
    const [verb = toggled, ...rest] = args.filter(a => a !== '--global')
    const c = await config($)
    const now = await $.clock.now()

    switch (verb) {
      case 'on':
        if (isGlobal) {
          await $.store.set('config', { ...(await rawConfig($)), globalOn: true })
          return { text: `Keepalive default is ON for new sessions${c.hours ? '' : ' (applies inside working hours once /keepalive setup is done)'}.` }
        }
        await setSession($, s => ({ ...s, mode: 'on', onSince: now, pingedFor: null }))
        return { text: 'Keepalive is ON for this session.' }
      case 'off':
        if (isGlobal) {
          await $.store.set('config', { ...(await rawConfig($)), globalOn: false })
          return { text: 'Keepalive default is OFF for new sessions.' }
        }
        await setSession($, s => ({ ...s, mode: 'off-manual', onSince: null }))
        return { text: 'Keepalive is OFF for this session (stays off until /keepalive on).' }
      case 'setup': {
        const h = parseHours(rest)
        if (typeof h === 'string') return { text: h }
        await $.store.set('config', { ...(await rawConfig($)), hours: h })
        return { text: `Working hours set: ${readableHours(h)}.` }
      }
      case 'margin': {
        const m = Number(rest[0])
        if (!(m > 0 && m < 60)) return { text: 'usage: /keepalive margin <minutes, 1-59>' }
        await $.store.set('config', { ...(await rawConfig($)), marginMin: m })
        return { text: `Ping when ${m} min of cache are left (at most half the cache length).` }
      }
      case 'view':
        return { text: await toggleView($) }
      case 'help':
        return { text: HELP }
      default:
        return { text: await askClaude($, rawArgs.trim(), HELP) }
    }
}

async function tick($: EngineInterface): Promise<void> {
  const [c, now, t] = [await config($), await $.clock.now(), await ttl($)]
  let s: Session = await read($, session)
  const after = applySchedule(s, c, now)
  if (after !== s) {
    await setSession($, () => after)
    $.ui.toast('Keepalive turned off by schedule.')
    s = after
  }
  let since = await read($, workingSince)
  if (since !== null && now - since > t) {
    // a turn end that never arrived must not block pings forever
    await update($, workingSince, () => null)
    since = null
  }
  if (isPinging || !shouldPing(s, c, now, t, since !== null)) return
  // the person is typing: try again next minute
  try { if ((await $.prompt.read()).text.trim()) return } catch {}
  isPinging = true
  try {
    await setSession($, x => ({ ...x, pingedFor: s.lastRequestAt }))
    pingTurnPending = true
    await $.prompt.submit({ text: PING_TEXT })
  } catch {
    pingTurnPending = false
    // pingedFor stays set: no retry every minute for this idle stretch
    $.ui.toast('Keepalive ping could not be sent; next try after your next turn.')
  } finally {
    isPinging = false
  }
}
