/**
 * dsh-peak-guard — host half.
 *
 * Pipeline: peak clock -> reminder -> re-check -> countdown -> wait until every
 * top-level session in the affected workspaces is idle -> send the wrap-up
 * phrase ONCE per workspace.
 *
 * Rules this file must keep:
 *  - one wrap-up command per WORKSPACE, never per conversation;
 *  - only after every top-level session there is idle;
 *  - never force a wrap-up mid-turn (a broken project costs more than peak tokens);
 *  - subagent sessions (`header.origin === 'subagent'`) never wrap up.
 *
 * Step 1 shipped the manifest and config surface. Step 2 (this file) adds the
 * clock, the schedule evaluator and the state machine. UI lands in step 3 and
 * the peak block in step 4.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TICK_MS = 30_000

/** Configuration defaults; every value is overridable from `cordis.patch.yml`. */
export const DEFAULTS = Object.freeze({
  enabled: false,
  leadMinutes: 30,
  recheckMinutes: 5,
  confirmMinutes: 10,
  wrapPhrase: '今天先到这里，现在收工',
  blockTokens: 2_000_000,
  blockLongConversations: false,
  clockOffsetMinutes: 0,
  profileIds: ['deepseek-v4'],
})

const NUMBER_FIELDS = Object.freeze([
  'leadMinutes',
  'recheckMinutes',
  'confirmMinutes',
  'blockTokens',
  'clockOffsetMinutes',
])

function pickNumber(raw, key, fallback) {
  const value = raw?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function pickBoolean(raw, key, fallback) {
  const value = raw?.[key]
  return typeof value === 'boolean' ? value : fallback
}

function pickString(raw, key, fallback) {
  const value = raw?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function pickStrings(raw, key, fallback) {
  const value = raw?.[key]
  if (!Array.isArray(value)) return fallback
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '')
  return items.length > 0 ? items : fallback
}

/**
 * Normalize one row's raw `config` into a complete option object.
 * @param {Record<string, unknown>} [config] raw row config.
 * @returns {typeof DEFAULTS} normalized options.
 */
export function readOptions(config = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  /** @type {Record<string, unknown>} */
  const options = { ...DEFAULTS }
  options.enabled = pickBoolean(raw, 'enabled', DEFAULTS.enabled)
  options.blockLongConversations = pickBoolean(
    raw,
    'blockLongConversations',
    DEFAULTS.blockLongConversations,
  )
  for (const key of NUMBER_FIELDS) options[key] = pickNumber(raw, key, DEFAULTS[key])
  options.wrapPhrase = pickString(raw, 'wrapPhrase', DEFAULTS.wrapPhrase)
  options.profileIds = pickStrings(raw, 'profileIds', DEFAULTS.profileIds)
  return /** @type {typeof DEFAULTS} */ (options)
}

/* ------------------------------------------------------------------ */
/* Schedule evaluation (pure; ported from the peak/off-peak rule model) */
/* ------------------------------------------------------------------ */

const formatters = new Map()

function formatterOf(timeZone) {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

const WEEKDAY = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })

function pad(value) {
  return value < 10 ? `0${value}` : `${value}`
}

/**
 * Wall-clock parts of one instant in a time zone (no date library).
 * @param {number} ts epoch milliseconds.
 * @param {string} timeZone IANA zone.
 */
export function zonedParts(ts, timeZone) {
  const parts = formatterOf(timeZone).formatToParts(new Date(ts))
  const value = (type) => Number(parts.find((part) => part.type === type)?.value)
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun'
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour') % 24,
    minute: value('minute'),
    weekday: WEEKDAY[weekdayName] ?? 0,
  }
}

/**
 * Epoch milliseconds of one wall-clock time in a time zone. The offset is
 * solved iteratively, so DST boundaries resolve to the real instant.
 * @param {string} timeZone IANA zone.
 * @param {number} year full year.
 * @param {number} month 1-12.
 * @param {number} day 1-31.
 * @param {number} hour 0-23.
 * @param {number} minute 0-59.
 */
export function wallInstant(timeZone, year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let ts = target
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(ts, timeZone)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
    const delta = target - asUtc
    if (delta === 0) break
    ts += delta
  }
  return ts
}

function parseClock(clock) {
  const [hour, minute] = String(clock).split(':')
  return [Number(hour), Number(minute)]
}

function currentMinuteOfDay(parts) {
  return parts.hour * 60 + parts.minute
}

function clockInside(windows, parts) {
  const current = currentMinuteOfDay(parts)
  return windows.some((window) => {
    if (window?.allDay === true) return true
    const [startHour, startMinute] = parseClock(window?.start)
    const [endHour, endMinute] = parseClock(window?.end)
    const start = startHour * 60 + startMinute
    const end = endHour * 60 + endMinute
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
    return start < end ? current >= start && current < end : current >= start || current < end
  })
}

function holidayDateKey(schedule, ts) {
  const zone = schedule.publicHolidayTimeZone ?? schedule.timeZone
  const parts = zonedParts(ts, zone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

/** Whether `ts` falls on a public holiday the schedule treats as fully off-peak. */
export function isPublicHoliday(schedule, ts) {
  const dates = schedule.publicHolidayDates
  if (!Array.isArray(dates) || dates.length === 0) return false
  return dates.includes(holidayDateKey(schedule, ts))
}

/** The campaign/override window covering `ts`, when the catalog declares one. */
export function activeOverride(schedule, ts) {
  const overrides = schedule.overrides
  if (!Array.isArray(overrides) || overrides.length === 0) return undefined
  const parts = zonedParts(ts, schedule.timeZone)
  for (const override of overrides) {
    const start = override?.startAt === undefined ? -Infinity : Date.parse(override.startAt)
    const end = override?.endAt === undefined ? Infinity : Date.parse(override.endAt)
    if (!(ts >= start) || !(ts < end)) continue
    const days = Array.isArray(override.days) ? override.days : undefined
    if (days !== undefined && !days.includes(parts.weekday)) continue
    const windows = Array.isArray(override.windows) ? override.windows : []
    if (windows.length === 0 || clockInside(windows, parts)) return override
  }
  return undefined
}

/**
 * Whether the peak rate is active at `ts`.
 * Priority: campaign override -> public holiday -> weekday filter -> clock window.
 */
export function isPeak(schedule, ts) {
  if (activeOverride(schedule, ts) !== undefined) return false
  if (isPublicHoliday(schedule, ts)) return false
  const parts = zonedParts(ts, schedule.timeZone)
  const days = Array.isArray(schedule.peakDays) ? schedule.peakDays : []
  if (!days.includes(parts.weekday)) return false
  const windows = Array.isArray(schedule.peakWindows) ? schedule.peakWindows : []
  return clockInside(windows, parts)
}

/**
 * Epoch milliseconds of the next moment the peak rate starts, strictly after
 * `ts`. Scans nine days so a weekend or a holiday run cannot exhaust the search.
 */
export function nextPeakStart(schedule, ts) {
  const windows = Array.isArray(schedule.peakWindows) ? schedule.peakWindows : []
  const days = Array.isArray(schedule.peakDays) ? schedule.peakDays : []
  if (windows.length === 0 || days.length === 0) return undefined
  for (let offset = 0; offset <= 9; offset += 1) {
    const probe = ts + offset * DAY
    const parts = zonedParts(probe, schedule.timeZone)
    if (!days.includes(parts.weekday)) continue
    for (const window of windows) {
      if (window?.allDay === true) continue
      const [hour, minute] = parseClock(window?.start)
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue
      const start = wallInstant(schedule.timeZone, parts.year, parts.month, parts.day, hour, minute)
      if (start > ts && isPeak(schedule, start)) return start
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Catalog access                                                      */
/* ------------------------------------------------------------------ */

function cacheFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-peakrate', 'pricing.json')
}

/** Profiles offered by `dsh-peakrate`, falling back to its disk cache. */
function loadProfiles(ctx) {
  try {
    const service = ctx.get('peakrate')
    const profiles = service?.profiles?.()
    if (Array.isArray(profiles) && profiles.length > 0) return profiles
  } catch {
    // fall through to the cache
  }
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8'))
    return Array.isArray(raw?.profiles) ? raw.profiles : []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* HTTP fence                                                          */
/* ------------------------------------------------------------------ */

function parseAuthority(rawHost) {
  try {
    const url = new URL(`http://${rawHost}`)
    if (url.hostname === '' || url.pathname !== '/') return undefined
    return { hostname: url.hostname, host: url.host }
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function isTrustedRequest(request, trustedHosts) {
  const rawHost = request.headers.host
  if (typeof rawHost !== 'string' || rawHost === '') return false
  const authority = parseAuthority(rawHost)
  if (authority === undefined) return false
  const trusted =
    isLoopbackHostname(authority.hostname) ||
    trustedHosts.some((entry) => {
      const candidate = String(entry).trim().toLowerCase()
      if (candidate === '') return false
      return candidate === authority.host.toLowerCase() || candidate === authority.hostname.toLowerCase()
    })
  if (!trusted) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host.toLowerCase() === authority.host.toLowerCase()
  } catch {
    return false
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', Buffer.byteLength(text))
  response.end(text)
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        request.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    request.on('error', () => resolve({}))
  })
}

/* ------------------------------------------------------------------ */
/* Guard runtime                                                       */
/* ------------------------------------------------------------------ */

function isTopLevel(session) {
  return session?.header?.origin !== 'subagent'
}

/**
 * Build one guard runtime. Exported so tests can drive the state machine with a
 * fake context and a simulated clock instead of installing the bundle.
 * @param {any} ctx plugin context.
 * @param {typeof DEFAULTS} options normalized options.
 * @param {(message: string) => void} log logger sink.
 */
export function createGuard(ctx, options, log) {
  const clock = { offsetMinutes: options.clockOffsetMinutes }
  const agents = new Map()
  let profile
  let occurrence = null
  let timer

  const now = () => Date.now() + clock.offsetMinutes * MINUTE

  function refreshProfile() {
    const profiles = loadProfiles(ctx)
    const preferred = options.profileIds
    profile =
      profiles.find((entry) => preferred.includes(entry?.id)) ??
      profiles.find((entry) => typeof entry?.id === 'string' && entry.id.includes('deepseek')) ??
      undefined
    return profile
  }

  function sessionOf(agentId) {
    try {
      return ctx.get('sessions')?.get(agentId)
    } catch {
      return undefined
    }
  }

  function remember(agent) {
    if (agent?.id === undefined) return
    const session = sessionOf(agent.id)
    if (session !== undefined && !isTopLevel(session)) return
    const cwd = session?.header?.cwd ?? ''
    const existing = agents.get(agent.id)
    agents.set(agent.id, {
      id: agent.id,
      cwd,
      origin: session?.header?.origin,
      status: agent.status === 'running' ? 'running' : 'idle',
      lastActiveAt: existing?.lastActiveAt ?? Date.now(),
      title: undefined,
    })
  }

  function entryOf(agentId) {
    return agents.get(agentId)
  }

  function topLevelEntries() {
    return [...agents.values()].filter((entry) => entry.origin !== 'subagent')
  }

  function runningEntries() {
    return topLevelEntries().filter((entry) => entry.status === 'running')
  }

  function runningInWorkspace(workspace) {
    return runningEntries().filter((entry) => entry.cwd === workspace)
  }

  function workspaceEntries(workspace) {
    return topLevelEntries().filter((entry) => entry.cwd === workspace)
  }

  function pickTarget(workspace) {
    const candidates = workspaceEntries(workspace)
    if (candidates.length === 0) return undefined
    const idle = candidates.filter((entry) => entry.status !== 'running')
    const pool = idle.length > 0 ? idle : candidates
    return pool.reduce((best, entry) =>
      best === undefined || entry.lastActiveAt >= best.lastActiveAt ? entry : best,
    undefined)
  }

  const tokensBySession = new Map()
  let lastBlock = null

  /** Sum every logged call's usage for one session, incrementally. */
  function cumulativeTokens(session) {
    if (session === undefined || session === null) return 0
    const cached = tokensBySession.get(session.id) ?? { seq: 0, total: 0 }
    let total = cached.total
    let events = []
    try {
      events = session.snapshotEvents(cached.seq)
    } catch {
      events = []
    }
    for (const event of events) {
      if (event.seq < cached.seq) continue
      if (event.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (usage === undefined) continue
      total +=
        typeof usage.totalTokens === 'number'
          ? usage.totalTokens
          : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    }
    tokensBySession.set(session.id, { seq: session.seq, total })
    return total
  }

  /** Whether the next step of this agent must be rejected right now. */
  function shouldBlock(agent) {
    if (!options.blockLongConversations) return false
    if (profile === undefined) refreshProfile()
    if (profile === undefined) return false
    const at = now()
    if (!isPeak(profile.schedule, at)) return false
    const session = sessionOf(agent?.id)
    const tokens = cumulativeTokens(session)
    if (tokens < options.blockTokens) return false
    lastBlock = { sessionId: agent.id, tokens, at: new Date(at).toISOString() }
    return true
  }

  async function sendWrap(sessionId, phrase) {
    const controller = ctx.get('sessionController')
    if (controller?.prompt === undefined) throw new Error('sessionController.prompt unavailable')
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: phrase }],
      },
      undefined,
    )
  }

  function startOccurrence(peakAt, at) {
    const running = runningEntries()
    const workspaces = [...new Set(running.map((entry) => entry.cwd))]
    occurrence = {
      peakAt,
      phase: running.length > 0 ? 'recheck' : 'done',
      outcome: running.length > 0 ? undefined : 'reminder-only',
      createdAt: at,
      recheckAt: at + options.recheckMinutes * MINUTE,
      confirmUntil: undefined,
      workspaces,
      sent: new Set(),
      lastTryAt: 0,
    }
    log(
      `[reminder] peak starts at ${new Date(peakAt).toISOString()} — ` +
        `${running.length} running session(s) in ${workspaces.length} workspace(s)`,
    )
    if (running.length === 0) log('[reminder] nothing running: reminder only, no wrap-up')
  }

  async function tryWrap(at) {
    for (const workspace of occurrence.workspaces) {
      if (occurrence.sent.has(workspace)) continue
      if (runningInWorkspace(workspace).length > 0) continue
      const target = pickTarget(workspace)
      if (target === undefined) {
        occurrence.sent.add(workspace)
        log(`[wrap] workspace ${workspace || '(none)'} has no live session; nothing sent`)
        continue
      }
      try {
        await sendWrap(target.id, options.wrapPhrase)
        occurrence.sent.add(workspace)
        log(`[wrap] sent "${options.wrapPhrase}" to ${target.id} (workspace ${workspace || '(none)'})`)
      } catch (error) {
        occurrence.phase = 'done'
        occurrence.outcome = 'wrap-failed'
        log(`[wrap] failed for ${target.id}: ${String(error)}`)
        return
      }
    }
    const allSent = occurrence.workspaces.every((workspace) => occurrence.sent.has(workspace))
    if (allSent) {
      occurrence.phase = 'done'
      occurrence.outcome = occurrence.outcome ?? 'wrap-sent'
    }
    void at
  }

  function tick() {
    try {
      const at = now()
      if (profile === undefined) refreshProfile()
      if (profile === undefined) return
      const schedule = profile.schedule
      const next = nextPeakStart(schedule, at)

      if (occurrence !== null && at > occurrence.peakAt + HOUR) occurrence = null
      if (
        occurrence !== null &&
        next !== undefined &&
        next !== occurrence.peakAt &&
        at < occurrence.peakAt &&
        at < next
      ) {
        occurrence = null
      }
      if (occurrence === null && next !== undefined) {
        const ahead = next - at
        if (ahead > 0 && ahead <= options.leadMinutes * MINUTE) startOccurrence(next, at)
      }
      if (occurrence === null) return
      if (occurrence.phase === 'recheck' && at >= occurrence.recheckAt) {
        const running = runningEntries().filter((entry) => occurrence.workspaces.includes(entry.cwd))
        if (running.length === 0) {
          occurrence.phase = 'done'
          occurrence.outcome = 'finished-before-recheck'
          log('[recheck] everything finished: reminder only, no wrap-up')
        } else {
          occurrence.phase = 'confirm'
          occurrence.confirmUntil = at + options.confirmMinutes * MINUTE
          log(
            `[recheck] still running (${running.length}); countdown until ` +
              `${new Date(occurrence.confirmUntil).toISOString()}`,
          )
        }
      } else if (occurrence.phase === 'confirm' && at >= occurrence.confirmUntil) {
        occurrence.phase = 'waitIdle'
        occurrence.outcome = 'waiting-for-idle'
        log('[confirm] no confirmation before the countdown ended: waiting for every session to go idle')
        void tryWrap(at)
      } else if (occurrence.phase === 'waitIdle' && at - occurrence.lastTryAt >= 5_000) {
        occurrence.lastTryAt = at
        void tryWrap(at)
      }
    } catch (error) {
      log(`tick failed: ${String(error)}`)
    }
  }

  function statePayload() {
    const at = now()
    if (profile === undefined) refreshProfile()
    const schedule = profile?.schedule
    const next = schedule === undefined ? undefined : nextPeakStart(schedule, at)
    const peakNow = schedule === undefined ? null : isPeak(schedule, at)
    return {
      now: new Date(at).toISOString(),
      clockOffsetMinutes: clock.offsetMinutes,
      profileId: profile?.id,
      peak: peakNow,
      nextPeakAt: next === undefined ? null : new Date(next).toISOString(),
      minutesToPeak: next === undefined ? null : Math.max(0, Math.round((next - at) / MINUTE)),
      leadMinutes: options.leadMinutes,
      wrapPhrase: options.wrapPhrase,
      occurrence:
        occurrence === null
          ? null
          : {
              peakAt: new Date(occurrence.peakAt).toISOString(),
              phase: occurrence.phase,
              outcome: occurrence.outcome ?? null,
              recheckAt:
                occurrence.recheckAt === undefined
                  ? null
                  : new Date(occurrence.recheckAt).toISOString(),
              confirmUntil:
                occurrence.confirmUntil === undefined
                  ? null
                  : new Date(occurrence.confirmUntil).toISOString(),
              workspaces: [...occurrence.workspaces],
              sent: [...occurrence.sent],
            },
      block: {
        enabled: options.blockLongConversations,
        threshold: options.blockTokens,
        active: options.blockLongConversations && peakNow === true,
        lastBlock,
      },
      sessions: [...agents.values()].map((entry) => {
        const session = sessionOf(entry.id)
        const tokens = session === undefined ? 0 : cumulativeTokens(session)
        return {
          id: entry.id,
          cwd: entry.cwd,
          status: entry.status,
          tokens,
          overThreshold: tokens >= options.blockTokens,
          lastActiveAt: new Date(entry.lastActiveAt).toISOString(),
        }
      }),
    }
  }

  function confirmNow() {
    if (occurrence === null || occurrence.phase !== 'confirm') {
      return { confirmed: false, reason: 'no-countdown-active' }
    }
    occurrence.phase = 'done'
    occurrence.outcome = 'confirmed-by-user'
    log('[confirm] user confirmed: auto wrap-up cancelled')
    return { confirmed: true }
  }

  function start() {
    const disposers = []
    const agentsService = (() => {
      try {
        return ctx.get('agents')
      } catch {
        return undefined
      }
    })()
    if (agentsService === undefined) {
      log('agents service unavailable: guard stays idle')
      return () => {}
    }
    try {
      for (const agent of agentsService.list()) remember(agent)
    } catch (error) {
      log(`initial agent scan failed: ${String(error)}`)
    }
    disposers.push(
      ctx.on('agent/created', ({ agent }) => {
        remember(agent)
      }),
    )
    disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        agents.delete(agent.id)
        tokensBySession.delete(agent.id)
      }),
    )
    disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        const entry = entryOf(agent.id)
        if (entry === undefined) {
          remember(agent)
          return
        }
        entry.status = status === 'running' ? 'running' : 'idle'
        entry.lastActiveAt = Date.now()
      }),
    )
    disposers.push(
      ctx.on('session/disposed', (session) => {
        if (session?.id !== undefined) {
          agents.delete(session.id)
          tokensBySession.delete(session.id)
        }
      }),
    )
    disposers.push(
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision === undefined || decision.kind !== 'enter') return decision
        try {
          if (shouldBlock(payload?.agent)) {
            log(
              `[block] session ${payload.agent.id} is at peak and over the token budget; step rejected`,
            )
            return { kind: 'reject' }
          }
        } catch (error) {
          log(`block check failed: ${String(error)}`)
        }
        return decision
      }),
    )

    try {
      ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.webServer
        if (webServer === undefined) return
        const trustedHosts = () => {
          try {
            const runtime = ctx.get('webRuntime')
            return Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : []
          } catch {
            return []
          }
        }
        const handler = async (request, response) => {
          if (!isTrustedRequest(request, trustedHosts())) {
            sendJson(response, 403, { error: 'forbidden' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const route = url.pathname.slice('/peak-guard'.length) || '/'
          if (route === '/state' && request.method === 'GET') {
            sendJson(response, 200, statePayload())
            return
          }
          if (route === '/confirm' && request.method === 'POST') {
            sendJson(response, 200, confirmNow())
            return
          }
          if (route === '/clock' && request.method === 'POST') {
            const body = await readBody(request)
            const minutes = Number(body?.minutes)
            if (Number.isFinite(minutes)) clock.offsetMinutes = minutes
            sendJson(response, 200, { clockOffsetMinutes: clock.offsetMinutes })
            return
          }
          if (route === '/reset' && request.method === 'POST') {
            occurrence = null
            sendJson(response, 200, { reset: true })
            return
          }
          if (route === '/check' && request.method === 'POST') {
            const body = await readBody(request)
            if (profile === undefined) refreshProfile()
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
            const session = sessionId === undefined ? undefined : sessionOf(sessionId)
            const tokens = cumulativeTokens(session)
            const at = now()
            const peakNow = profile === undefined ? null : isPeak(profile.schedule, at)
            sendJson(response, 200, {
              sessionId: sessionId ?? null,
              tokens,
              peak: peakNow,
              threshold: options.blockTokens,
              wouldBlock:
                options.blockLongConversations === true &&
                peakNow === true &&
                tokens >= options.blockTokens,
            })
            return
          }
          sendJson(response, 404, { error: 'not-found' })
        }
        const dispose = webServer.register({ kind: 'prefix', path: '/peak-guard', handler })
        webCtx.effect(() => dispose)
      })
    } catch (error) {
      log(`route registration failed: ${String(error)}`)
    }

    timer = setInterval(tick, TICK_MS)
    timer.unref?.()
    disposers.push(() => clearInterval(timer))
    const warmup = setTimeout(tick, 2_000)
    warmup.unref?.()
    disposers.push(() => clearTimeout(warmup))
    log(
      `started (lead=${options.leadMinutes}m, recheck=${options.recheckMinutes}m, ` +
        `confirm=${options.confirmMinutes}m, profiles=${options.profileIds.join(',')})`,
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // teardown failures must not stop the remaining disposers
        }
      }
    }
  }

  return {
    start,
    tick,
    statePayload,
    confirmNow,
    /** Shift the simulated clock by `minutes` from the real clock (tests, dry runs). */
    setClockOffset(minutes) {
      clock.offsetMinutes = minutes
    },
  }
}

/**
 * Host entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {Record<string, unknown>} [config] row config.
 */
export function apply(ctx, config = {}) {
  const options = readOptions(config)
  const logger = ctx.get('logger')
  const log = (message) => logger?.info?.(`[peak-guard] ${message}`)
  if (!options.enabled) {
    log('loaded but disabled (enabled=false)')
    return
  }
  const guard = createGuard(ctx, options, log)
  ctx.effect(() => guard.start(), 'peak-guard lifecycle')
}

export const name = 'dsh-peak-guard'
