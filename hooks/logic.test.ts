import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_CONFIG, MINUTE_MS, NEW_SESSION,
  applySchedule, isWithinHours, nextCutoff, onUserMessage, parseHours,
  readableHours, shouldPing, statusText, ttlMs,
} from './logic'
import type { Config, Hours, Session } from './logic'

// Local-time instants. 2026-11-02 is a Monday.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime()
const MON = 2, FRI = 6, SAT = 7, SUN = 8, NEXT_MON = 9
const HOURS: Hours = { start: 8, end: 18, days: [1, 2, 3, 4, 5] }
const CFG: Config = { ...DEFAULT_CONFIG, hours: HOURS, marginMin: 2 }
const HOUR = 60 * MINUTE_MS
const on = (since: number, last: number | null = null): Session => ({ ...NEW_SESSION, mode: 'on', onSince: since, lastRequestAt: last })

test('ttl: 1 h by default, 5 min when forced or set to 5m', async () => {
  expect(ttlMs(undefined, undefined)).toBe(HOUR)
  expect(ttlMs('5m', undefined)).toBe(5 * MINUTE_MS)
  expect(ttlMs(undefined, '1')).toBe(5 * MINUTE_MS)
  expect(ttlMs(undefined, '0')).toBe(HOUR)
})

test('defaults: off, Mon-Fri 9 am-5 pm, 2 min margin', async () => {
  expect(DEFAULT_CONFIG.globalOn).toBe(false)
  expect(DEFAULT_CONFIG.hours).toEqual({ start: 9, end: 17, days: [1, 2, 3, 4, 5] })
  expect(DEFAULT_CONFIG.marginMin).toBe(2)
  expect(NEW_SESSION.mode).toBe('none')
})

test('working hours: inside, edges, weekend', async () => {
  expect(isWithinHours(HOURS, at(MON, 8))).toBe(true)
  expect(isWithinHours(HOURS, at(MON, 7, 59))).toBe(false)
  expect(isWithinHours(HOURS, at(MON, 17, 59))).toBe(true)
  expect(isWithinHours(HOURS, at(MON, 18))).toBe(false)
  expect(isWithinHours(HOURS, at(SAT, 10))).toBe(false)
})

test('cutoff: same day, after hours, Friday night skips the weekend', async () => {
  expect(nextCutoff(HOURS, at(MON, 9))).toBe(at(MON, 18))
  expect(nextCutoff(HOURS, at(MON, 19))).toBe(at(MON + 1, 18))
  expect(nextCutoff(HOURS, at(FRI, 19))).toBe(at(NEXT_MON, 18))
  expect(nextCutoff(HOURS, at(SUN, 12))).toBe(at(NEXT_MON, 18))
  expect(nextCutoff({ ...HOURS, end: 17.5 }, at(MON, 9))).toBe(at(MON, 17, 30))
  // end 24 = midnight: Friday's window ends Saturday 00:00, not next week (regression)
  expect(nextCutoff({ ...HOURS, end: 24 }, at(FRI, 9))).toBe(at(SAT, 0))
})

test('schedule: on turns off-scheduled at its cutoff, once', async () => {
  const s = on(at(MON, 9))
  expect(applySchedule(s, CFG, at(MON, 17, 59))).toBe(s)
  const off = applySchedule(s, CFG, at(MON, 18))
  expect(off.mode).toBe('off-scheduled')
  expect(applySchedule(off, CFG, at(MON, 19))).toBe(off)
})

test('schedule: turned on after hours runs until the next working day', async () => {
  const s = on(at(MON, 19))
  expect(applySchedule(s, CFG, at(MON, 23)).mode).toBe('on')
  expect(applySchedule(s, CFG, at(MON + 1, 18)).mode).toBe('off-scheduled')
})

test('schedule: no hours set means no cutoff', async () => {
  const s = on(at(MON, 9))
  expect(applySchedule(s, { ...CFG, hours: null }, at(MON + 3, 23))).toBe(s)
})

test('schedule: manual off is never touched', async () => {
  const s: Session = { ...NEW_SESSION, mode: 'off-manual' }
  expect(applySchedule(s, CFG, at(MON, 19))).toBe(s)
})

test('resume: off-scheduled comes back on a message inside hours only', async () => {
  const s: Session = { ...NEW_SESSION, mode: 'off-scheduled' }
  expect(onUserMessage(s, CFG, at(MON, 19)).mode).toBe('off-scheduled')
  expect(onUserMessage(s, CFG, at(SAT, 10)).mode).toBe('off-scheduled')
  const back = onUserMessage(s, CFG, at(MON + 1, 8, 30))
  expect(back.mode).toBe('on')
  expect(back.onSince).toBe(at(MON + 1, 8, 30))
})

test('resume: manual off stays off', async () => {
  const s: Session = { ...NEW_SESSION, mode: 'off-manual' }
  expect(onUserMessage(s, CFG, at(MON, 10))).toBe(s)
})

test('global default: none turns on inside hours when the default is on', async () => {
  expect(onUserMessage(NEW_SESSION, CFG, at(MON, 10))).toBe(NEW_SESSION)
  const g = { ...CFG, globalOn: true }
  expect(onUserMessage(NEW_SESSION, g, at(MON, 10)).mode).toBe('on')
  expect(onUserMessage(NEW_SESSION, g, at(MON, 19)).mode).toBe('none')
  expect(onUserMessage(NEW_SESSION, { ...g, hours: null }, at(MON, 10)).mode).toBe('none')
})

test('ping: only when on, idle, with a request, inside the margin, once', async () => {
  const last = at(MON, 9)
  const s = on(last, last)
  expect(shouldPing(s, CFG, last + 57 * MINUTE_MS, HOUR, false)).toBe(false) // 3 min left
  expect(shouldPing(s, CFG, last + 58 * MINUTE_MS, HOUR, false)).toBe(true) // 2 min left
  expect(shouldPing(s, CFG, last + 58 * MINUTE_MS, HOUR, true)).toBe(false) // busy
  expect(shouldPing(s, CFG, last + 60 * MINUTE_MS, HOUR, false)).toBe(false) // expired
  expect(shouldPing({ ...s, pingedFor: last }, CFG, last + 58 * MINUTE_MS, HOUR, false)).toBe(false)
  expect(shouldPing({ ...s, lastRequestAt: null }, CFG, last + 58 * MINUTE_MS, HOUR, false)).toBe(false)
  expect(shouldPing({ ...s, mode: 'off-manual' }, CFG, last + 58 * MINUTE_MS, HOUR, false)).toBe(false)
  // a margin at or over the cache length is capped at half of it: no ping every tick (regression)
  const five = 5 * MINUTE_MS
  expect(shouldPing(s, { ...CFG, marginMin: 16 }, last + MINUTE_MS, five, false)).toBe(false)
  expect(shouldPing(s, { ...CFG, marginMin: 16 }, last + 3 * MINUTE_MS, five, false)).toBe(true)
})

test('ping: a 16 min margin pings at 44 min idle', async () => {
  const last = at(MON, 9)
  const c = { ...CFG, marginMin: 16 }
  expect(shouldPing(on(last, last), c, last + 43 * MINUTE_MS, HOUR, false)).toBe(false)
  expect(shouldPing(on(last, last), c, last + 44 * MINUTE_MS, HOUR, false)).toBe(true)
})

test('hours: parsing and readable text', async () => {
  expect(parseHours(['8', '18', '1-5'])).toEqual(HOURS)
  expect(parseHours(['9', '17', '1,3'])).toEqual({ start: 9, end: 17, days: [1, 3] })
  expect(parseHours(['8', '18'])).toEqual(HOURS)
  expect(typeof parseHours(['18', '8'])).toBe('string')
  for (const bad of [['8', '18', '1-9'], ['8', '18', '5-1'], ['8', '18', 'a-b'], ['8', '18', '1,,2'], ['8', '18', '1.5'], ['x', '18'], ['8', '25']]) {
    expect(typeof parseHours(bad)).toBe('string')
  }
  expect(parseHours(['0', '24', '1,1,2'])).toEqual({ start: 0, end: 24, days: [1, 2] })
  expect(readableHours(HOURS)).toBe('Mon-Fri 8 am-6 pm')
  expect(readableHours({ start: 0, end: 12.5, days: [1, 3] })).toBe('Mon,Wed 12 am-12:30 pm')
})

test('status line text', async () => {
  const last = at(MON, 9)
  expect(statusText(on(last, last), CFG, last + 15 * MINUTE_MS, HOUR)).toBe('ON · ⏰ Mon-Fri 8 am-6 pm · cache 45/60m ping in 43m')
  expect(statusText(on(last, last), CFG, last + 61 * MINUTE_MS, HOUR)).toBe('ON · ⏰ Mon-Fri 8 am-6 pm · cache 0/60m')
  expect(statusText({ ...on(last, last), pingedFor: last }, CFG, last + 15 * MINUTE_MS, HOUR)).toBe('ON · ⏰ Mon-Fri 8 am-6 pm · cache 45/60m')
  // countdown uses the clamped margin, like shouldPing
  expect(statusText(on(last, last), { ...CFG, marginMin: 16 }, last + MINUTE_MS, 5 * MINUTE_MS)).toBe('ON · ⏰ Mon-Fri 8 am-6 pm · cache 4/5m ping in 2m')
  expect(statusText(on(last), CFG, last, HOUR)).toBe('ON · ⏰ Mon-Fri 8 am-6 pm')
  expect(statusText(NEW_SESSION, { ...CFG, hours: null }, last, HOUR)).toBe('OFF · no schedule')
  expect(statusText(NEW_SESSION, { ...CFG, globalOn: true }, last, HOUR)).toBe('auto · ⏰ Mon-Fri 8 am-6 pm')
  expect(statusText({ ...NEW_SESSION, mode: 'off-manual' }, CFG, last, HOUR)).toBe('OFF (manual) · ⏰ Mon-Fri 8 am-6 pm')
  expect(statusText({ ...NEW_SESSION, mode: 'off-manual', lastRequestAt: last }, CFG, last + 15 * MINUTE_MS, HOUR)).toBe('OFF (manual) · ⏰ Mon-Fri 8 am-6 pm · cache 45/60m')
  expect(statusText({ ...NEW_SESSION, mode: 'off-scheduled' }, CFG, last, HOUR)).toBe('OFF (schedule) · ⏰ Mon-Fri 8 am-6 pm')
})
