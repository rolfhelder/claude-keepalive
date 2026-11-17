// Pure rules: no engine calls, so they can be tested alone.

export const MINUTE_MS = 60_000

import type { Session } from '../types'
export type { Session, SessionMode } from '../types'

export type Hours = { start: number; end: number; days: number[] } // hours 0-24, days 0=Sun..6=Sat

export type Config = {
  hours: Hours | null // null: not set up, manual path only
  globalOn: boolean
  marginMin: number // ping when this many minutes of cache are left
}

export const DEFAULT_HOURS: Hours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] }

export const DEFAULT_CONFIG: Config = { hours: DEFAULT_HOURS, globalOn: false, marginMin: 2 }

export const NEW_SESSION: Session = { mode: 'none', onSince: null, lastRequestAt: null, pingedFor: null }

export function ttlMs(ttlVar: string | undefined, force5m: string | undefined): number {
  if (force5m && force5m !== '0' && force5m !== 'false') return 5 * MINUTE_MS
  if (ttlVar && /^5m?$/.test(ttlVar.trim())) return 5 * MINUTE_MS
  return 60 * MINUTE_MS
}

export function isWithinHours(h: Hours, at: number): boolean {
  const d = new Date(at)
  const hour = d.getHours() + d.getMinutes() / 60
  return h.days.includes(d.getDay()) && hour >= h.start && hour < h.end
}

/** The first end-of-window instant strictly after `since`, on a working day. */
export function nextCutoff(h: Hours, since: number): number {
  const d = new Date(since)
  for (let i = 0; i < 8; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i)
    if (!h.days.includes(day.getDay())) continue
    const c = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(h.end), Math.round((h.end % 1) * 60))
    if (c.getTime() > since) return c.getTime()
  }
  return Number.POSITIVE_INFINITY
}

/** Applies schedule rules on a tick. Returns the new session (same object if unchanged). */
export function applySchedule(s: Session, c: Config, now: number): Session {
  if (!c.hours) return s
  if (s.mode === 'on' && s.onSince !== null && now >= nextCutoff(c.hours, s.onSince)) {
    return { ...s, mode: 'off-scheduled', onSince: null }
  }
  return s
}

/** On a user message: resume a scheduled-off session, or adopt the global default. */
export function onUserMessage(s: Session, c: Config, now: number): Session {
  const inHours = c.hours ? isWithinHours(c.hours, now) : false
  if (s.mode === 'off-scheduled' && inHours) return { ...s, mode: 'on', onSince: now }
  if (s.mode === 'none' && c.globalOn && inHours) return { ...s, mode: 'on', onSince: now }
  return s
}

export function shouldPing(s: Session, c: Config, now: number, ttl: number, isWorking: boolean): boolean {
  if (s.mode !== 'on' || isWorking || s.lastRequestAt === null) return false
  if (s.pingedFor === s.lastRequestAt) return false
  const left = ttl - (now - s.lastRequestAt)
  return left > 0 && left <= marginMs(c, ttl)
}

/** The margin in ms, capped at half the cache: a margin near the cache length would ping every tick. */
export function marginMs(c: Config, ttl: number): number {
  return Math.min(c.marginMin * MINUTE_MS, ttl / 2)
}

export function parseHours(args: string[]): Hours | string {
  const usage = 'usage: /keepalive setup <start-hour> <end-hour> [days: 1-5 or 1,3,5; 0=Sun]'
  const [a, b, days = '1-5'] = args
  const start = Number(a), end = Number(b)
  if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 24 && start < end)) return usage
  const isDay = (t: string) => /^[0-6]$/.test(t)
  let ds: number[]
  const range = /^([0-6])-([0-6])$/.exec(days)
  if (range) {
    const [x, y] = [Number(range[1]), Number(range[2])]
    if (x > y) return usage
    ds = Array.from({ length: y - x + 1 }, (_, i) => x + i)
  } else {
    const parts = days.split(',')
    if (!parts.every(isDay)) return usage
    ds = [...new Set(parts.map(Number))]
  }
  return { start, end, days: ds }
}

export function describe(s: Session, c: Config, now: number, ttl: number): string {
  const lines = [`session: ${s.mode}`, `global default: ${c.globalOn ? 'on' : 'off'}`]
  lines.push(c.hours ? `hours: ${readableHours(c.hours)} (now ${isWithinHours(c.hours, now) ? 'inside' : 'outside'})` : 'hours: not set (manual only) - /keepalive setup <start> <end> [days]')
  if (s.mode === 'on' && c.hours && s.onSince !== null) lines.push(`cutoff: ${new Date(nextCutoff(c.hours, s.onSince)).toLocaleString()}`)
  if (s.lastRequestAt !== null) lines.push(`cache left: ~${Math.max(0, Math.round((ttl - (now - s.lastRequestAt)) / MINUTE_MS))} min, ping at ${marginMs(c, ttl) / MINUTE_MS} min left`)
  if (s.mode === 'off-scheduled') lines.push('turned off by the schedule; your next message inside working hours turns it back on')
  return lines.join('\n')
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function clock12(h: number): string {
  const hh = Math.floor(h), mm = Math.round((h % 1) * 60)
  const suffix = hh % 24 < 12 ? 'am' : 'pm'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${suffix}`
}

/** "Mon-Fri 8 am-6 pm", "Mon,Wed 9 am-5 pm". */
export function readableHours(h: Hours): string {
  const ds = [...h.days].sort((a, b) => a - b)
  const isRun = ds.length > 2 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1)
  const days = isRun ? `${DAY[ds[0]]}-${DAY[ds[ds.length - 1]]}` : ds.map(d => DAY[d]).join(',')
  return `${days} ${clock12(h.start)}-${clock12(h.end)}`
}

/** One line for the status bar. */
export function statusText(s: Session, c: Config, now: number, ttl: number): string {
  const mode =
    s.mode === 'on' ? 'ON'
    : s.mode === 'off-manual' ? 'OFF (manual)'
    : s.mode === 'off-scheduled' ? 'OFF (schedule)'
    : c.globalOn ? 'auto' : 'OFF'
  const parts = [mode]
  parts.push(c.hours ? `⏰ ${readableHours(c.hours)}` : 'no schedule')
  if (s.lastRequestAt !== null) {
    const leftMs = ttl - (now - s.lastRequestAt)
    const left = Math.max(0, Math.round(leftMs / MINUTE_MS))
    const armed = s.mode === 'on' && leftMs > 0 && s.pingedFor !== s.lastRequestAt
    const ping = armed ? ` ping in ${Math.max(0, Math.round((leftMs - marginMs(c, ttl)) / MINUTE_MS))}m` : ''
    parts.push(`cache ${left}/${Math.round(ttl / MINUTE_MS)}m${ping}`)
  }
  return parts.join(' · ')
}
