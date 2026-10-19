/**
 * State-machine tests: reminder -> re-check -> countdown -> wait for idle ->
 * one wrap-up command per workspace.
 *
 * The guard is driven with a fake host context and a simulated clock, so no
 * bundle installation is needed. Run: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGuard, readOptions } from '../index.js'

function loadSchedule() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return undefined
  try {
    const raw = JSON.parse(
      readFileSync(join(profileDir, 'node_modules/dsh-peakrate/data/pricing.json'), 'utf8'),
    )
    return raw.profiles.find((entry) => entry.id === 'deepseek-v4')?.schedule
  } catch {
    return undefined
  }
}

const schedule = loadSchedule()
const beijing = (iso) => Date.parse(`${iso}+08:00`)

/** Minutes to add to the real clock so the guard reads `target` as "now". */
function offsetTo(target) {
  return (target - Date.now()) / 60_000
}

function makeHost({ sessions, agents, profiles }) {
  const handlers = new Map()
  const prompts = []
  const ctx = {
    get(name) {
      if (name === 'logger') return { info() {}, warn() {} }
      if (name === 'peakrate') return { profiles: () => profiles }
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            prompts.push(request)
            return { accepted: true }
          },
        }
      }
      if (name === 'webRuntime') return {}
      if (name === 'agents') return ctx.agents
      if (name === 'sessions') return ctx.sessions
      return undefined
    },
    on(name, listener) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(listener)
      return () => handlers.get(name)?.delete(listener)
    },
    inject(_deps, callback) {
      callback({ effect() {} })
    },
    effect(callback) {
      callback()
    },
    agents: { list: () => [...agents.values()].map((agent) => ({ ...agent })) },
    sessions: { get: (id) => sessions.get(id) },
    emit(name, payload) {
      for (const listener of handlers.get(name) ?? []) listener(payload)
    },
  }
  return { ctx, prompts, handlers }
}

function makeGuard(host, options) {
  const guard = createGuard(host.ctx, readOptions(options), () => {})
  guard.start()
  return guard
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

const OPTIONS = {
  enabled: true,
  leadMinutes: 30,
  recheckMinutes: 5,
  confirmMinutes: 10,
  wrapPhrase: '今天先到这里，现在收工',
}

function twoRunningSessions() {
  const sessions = new Map([
    ['s1', { id: 's1', header: { cwd: 'F:\\Forest Emporium' } }],
    ['s2', { id: 's2', header: { cwd: 'F:\\Forest Emporium' } }],
  ])
  const agents = new Map([
    ['s1', { id: 's1', status: 'running' }],
    ['s2', { id: 's2', status: 'running' }],
  ])
  return { sessions, agents }
}

test('full path: lead banner -> countdown -> wrap once after all idle', { skip: !schedule }, async () => {
  const { sessions, agents } = twoRunningSessions()
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:30:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'lead')
  assert.equal(host.prompts.length, 0)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:36:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'confirm')
  assert.equal(host.prompts.length, 0)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:46:00')))
  guard.tick()
  await settle()
  assert.equal(guard.statePayload().occurrence.phase, 'waitIdle')
  assert.equal(host.prompts.length, 0)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:50:00')))
  host.ctx.emit('agent/status', { agent: { id: 's1' }, status: 'idle' })
  guard.tick()
  await settle()
  assert.equal(host.prompts.length, 0, 'still waiting for s2')

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:55:00')))
  host.ctx.emit('agent/status', { agent: { id: 's2' }, status: 'idle' })
  guard.tick()
  await settle()
  assert.equal(host.prompts.length, 1, 'exactly one wrap-up for the workspace')
  assert.equal(host.prompts[0].sessionId, 's2', 'last finishing session is the target')
  assert.equal(host.prompts[0].mode, 'queue')
  assert.equal(host.prompts[0].content[0].text, '今天先到这里，现在收工')
  assert.equal(guard.statePayload().occurrence.phase, 'done')

  guard.tick()
  await settle()
  assert.equal(host.prompts.length, 1, 'never sends twice')
})

test('user confirmation cancels the auto wrap-up', { skip: !schedule }, async () => {
  const { sessions, agents } = twoRunningSessions()
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:30:00')))
  guard.tick()
  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:36:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'confirm')

  assert.deepEqual(guard.confirmNow(), { confirmed: true })
  guard.setClockOffset(offsetTo(beijing('2026-10-19T09:10:00')))
  guard.tick()
  await settle()
  assert.equal(host.prompts.length, 0)
  assert.equal(guard.statePayload().occurrence.outcome, 'confirmed-by-user')
})

test('nothing running: reminder only, no wrap-up', { skip: !schedule }, async () => {
  const sessions = new Map([['s1', { id: 's1', header: { cwd: 'F:\\Forest Emporium' } }]])
  const agents = new Map([['s1', { id: 's1', status: 'idle' }]])
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:30:00')))
  guard.tick()
  const state = guard.statePayload().occurrence
  assert.equal(state.phase, 'lead')
  assert.equal(state.outcome, null)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T09:05:00')))
  guard.tick()
  await settle()
  assert.equal(guard.statePayload().occurrence.outcome, 'reminder-only')
  assert.equal(host.prompts.length, 0)
})

test('different workspaces wrap up separately', { skip: !schedule }, async () => {
  const sessions = new Map([
    ['a', { id: 'a', header: { cwd: 'F:\\Forest Emporium' } }],
    ['b', { id: 'b', header: { cwd: 'E:\\ds' } }],
  ])
  const agents = new Map([
    ['a', { id: 'a', status: 'running' }],
    ['b', { id: 'b', status: 'running' }],
  ])
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:30:00')))
  guard.tick()
  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:36:00')))
  guard.tick()
  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:46:00')))
  guard.tick()
  host.ctx.emit('agent/status', { agent: { id: 'a' }, status: 'idle' })
  host.ctx.emit('agent/status', { agent: { id: 'b' }, status: 'idle' })
  guard.tick()
  await settle()

  assert.equal(host.prompts.length, 2)
  assert.deepEqual(
    host.prompts.map((prompt) => prompt.sessionId).sort(),
    ['a', 'b'],
  )
})

test('subagent sessions never trigger or receive a wrap-up', { skip: !schedule }, async () => {
  const sessions = new Map([
    ['child', { id: 'child', header: { cwd: 'F:\\Forest Emporium', origin: 'subagent' } }],
  ])
  const agents = new Map([['child', { id: 'child', status: 'running' }]])
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:30:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'lead')
  assert.equal(guard.statePayload().sessions.length, 0)
})

test('a task that starts mid-window is caught by the next 5-minute check', { skip: !schedule }, async () => {
  const sessions = new Map([['s1', { id: 's1', header: { cwd: 'E:\\ds' } }]])
  const agents = new Map([['s1', { id: 's1', status: 'idle' }]])
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:30:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'lead')

  // 08:36 check: still nothing running, banner stays.
  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:36:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'lead')

  // A task starts at 08:44; the 08:46 check must catch it.
  host.ctx.emit('agent/status', { agent: { id: 's1' }, status: 'running' })
  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:46:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'confirm')
})

test('cancelling suppresses this peak entirely', { skip: !schedule }, async () => {
  const { sessions, agents } = twoRunningSessions()
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:40:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence.phase, 'lead')
  assert.equal(guard.cancelOccurrence().cancelled, true)
  assert.equal(guard.statePayload().occurrence, null)

  // Still within the lead window, but suppression keeps the banner away.
  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:50:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence, null)

  await settle()
  assert.equal(host.prompts.length, 0)
})

test('weekend: no reminder at all', { skip: !schedule }, async () => {
  const { sessions, agents } = twoRunningSessions()
  const host = makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
  const guard = makeGuard(host, OPTIONS)

  guard.setClockOffset(offsetTo(beijing('2026-10-17T10:00:00')))
  guard.tick()
  assert.equal(guard.statePayload().occurrence, null)
})

/* ------------------------------------------------------------------ */
/* Peak block                                                          */
/* ------------------------------------------------------------------ */

function sessionWithTokens(id, cwd, tokens) {
  const events = [
    {
      seq: 1,
      type: 'assistant/message',
      data: {
        usage: { inputTokens: tokens - 1000, outputTokens: 1000, totalTokens: tokens },
      },
    },
  ]
  return {
    id,
    header: { cwd },
    get seq() {
      return 2
    },
    snapshotEvents(fromSeq) {
      return events.filter((event) => event.seq >= fromSeq)
    },
  }
}

function blockHost(tokens) {
  const sessions = new Map([['s1', sessionWithTokens('s1', 'F:\\Forest Emporium', tokens)]])
  const agents = new Map([['s1', { id: 's1', status: 'running' }]])
  return makeHost({ sessions, agents, profiles: [{ id: 'deepseek-v4', schedule }] })
}

async function runPreStep(host, sessionId = 's1', nextDecision = { kind: 'enter', messages: [] }) {
  const listeners = [...(host.handlers?.get('agent/pre-step') ?? [])]
  let decision
  for (const listener of listeners) {
    decision = await listener({ agent: { id: sessionId }, messages: [], turn: 1, step: 1 }, async () => nextDecision)
  }
  return decision
}

function makeGuardWithBlock(host) {
  const guard = createGuard(host.ctx, readOptions({ ...OPTIONS, blockLongConversations: true }), () => {})
  guard.start()
  return guard
}

test('peak block rejects a step over the token budget', { skip: !schedule }, async () => {
  const host = blockHost(2_100_000)
  const guard = makeGuardWithBlock(host)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T10:00:00')))
  assert.equal(guard.statePayload().peak, true)

  const decision = await runPreStep(host)
  assert.deepEqual(decision, { kind: 'reject' })
  const state = guard.statePayload()
  assert.equal(state.block.active, true)
  assert.equal(state.block.lastBlock.sessionId, 's1')
  assert.equal(state.sessions[0].overThreshold, true)
})

test('peak block lets an under-budget session through', { skip: !schedule }, async () => {
  const host = blockHost(1_500_000)
  const guard = makeGuardWithBlock(host)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T10:00:00')))
  const decision = await runPreStep(host)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('off-peak never blocks', { skip: !schedule }, async () => {
  const host = blockHost(5_000_000)
  const guard = makeGuardWithBlock(host)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T08:00:00')))
  const decision = await runPreStep(host)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('block switch off never blocks', { skip: !schedule }, async () => {
  const host = blockHost(5_000_000)
  const guard = createGuard(host.ctx, readOptions(OPTIONS), () => {})
  guard.start()

  guard.setClockOffset(offsetTo(beijing('2026-10-19T10:00:00')))
  const decision = await runPreStep(host)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('an existing rejection is preserved', { skip: !schedule }, async () => {
  const host = blockHost(0)
  const guard = makeGuardWithBlock(host)

  guard.setClockOffset(offsetTo(beijing('2026-10-19T10:00:00')))
  const decision = await runPreStep(host, 's1', { kind: 'reject' })
  assert.deepEqual(decision, { kind: 'reject' })
})
