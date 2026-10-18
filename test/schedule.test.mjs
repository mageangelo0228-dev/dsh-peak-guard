/**
 * Unit tests for the pure schedule evaluator.
 *
 * Run: node --test test/
 *
 * The catalog fixture is read from the installed dsh-peakrate package when it is
 * available (`DSH_PROFILE_DIR`); tests that need it skip otherwise, so the suite
 * also runs on a bare checkout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isPeak, nextPeakStart, readOptions, wallInstant, zonedParts } from '../index.js'

function loadDeepSeekProfile() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return undefined
  try {
    const raw = JSON.parse(
      readFileSync(join(profileDir, 'node_modules/dsh-peakrate/data/pricing.json'), 'utf8'),
    )
    return raw.profiles.find((entry) => entry.id === 'deepseek-v4')
  } catch {
    return undefined
  }
}

const deepseek = loadDeepSeekProfile()
const schedule = deepseek?.schedule

const beijing = (iso) => Date.parse(`${iso}+08:00`)

test('deepseek profile is present in the installed catalog', { skip: deepseek === undefined }, () => {
  assert.equal(schedule.timeZone, 'UTC')
  assert.deepEqual(schedule.peakWindows, [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ])
})

test('weekday peak windows are evaluated in the catalog time zone', { skip: !schedule }, () => {
  // 2026-10-19 is a Monday. Beijing 09:00-12:00 == UTC 01:00-04:00.
  assert.equal(isPeak(schedule, beijing('2026-10-19T08:59:00')), false)
  assert.equal(isPeak(schedule, beijing('2026-10-19T09:00:00')), true)
  assert.equal(isPeak(schedule, beijing('2026-10-19T11:59:00')), true)
  assert.equal(isPeak(schedule, beijing('2026-10-19T12:00:00')), false)
  assert.equal(isPeak(schedule, beijing('2026-10-19T13:59:00')), false)
  assert.equal(isPeak(schedule, beijing('2026-10-19T14:00:00')), true)
  assert.equal(isPeak(schedule, beijing('2026-10-19T18:00:00')), false)
})

test('weekends are fully off-peak', { skip: !schedule }, () => {
  assert.equal(isPeak(schedule, beijing('2026-10-17T10:00:00')), false)
  assert.equal(isPeak(schedule, beijing('2026-10-18T10:00:00')), false)
})

test('Chinese public holidays are fully off-peak', { skip: !schedule }, () => {
  // 2026-10-01 (Thursday) is in the catalog holiday list.
  assert.equal(isPeak(schedule, beijing('2026-10-01T10:00:00')), false)
})

test('next peak start skips a weekend', { skip: !schedule }, () => {
  const fridayEvening = beijing('2026-10-23T19:00:00')
  const next = nextPeakStart(schedule, fridayEvening)
  assert.equal(next, beijing('2026-10-26T09:00:00'))
})

test('next peak start lands on the coming window', { skip: !schedule }, () => {
  assert.equal(nextPeakStart(schedule, beijing('2026-10-19T08:00:00')), beijing('2026-10-19T09:00:00'))
  assert.equal(nextPeakStart(schedule, beijing('2026-10-19T12:30:00')), beijing('2026-10-19T14:00:00'))
  assert.equal(nextPeakStart(schedule, beijing('2026-10-19T17:00:00')), beijing('2026-10-20T09:00:00'))
})

test('next peak start is undefined without a schedule', () => {
  assert.equal(nextPeakStart({}, Date.now()), undefined)
})

test('wall time round-trips through the zone formatter', () => {
  const ts = wallInstant('Asia/Shanghai', 2026, 10, 19, 9, 0)
  assert.equal(ts, Date.UTC(2026, 9, 19, 1, 0))
  const parts = zonedParts(ts, 'Asia/Shanghai')
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute },
    { year: 2026, month: 10, day: 19, hour: 9, minute: 0 },
  )
})

test('readOptions falls back to safe defaults', () => {
  const options = readOptions({ enabled: 'yes', leadMinutes: -3, profileIds: [] })
  assert.equal(options.enabled, false)
  assert.equal(options.leadMinutes, 30)
  assert.deepEqual(options.profileIds, ['deepseek-v4'])
  assert.equal(options.wrapPhrase, '今天先到这里，现在收工')
})
