/**
 * dsh-peak-guard — Client (web) half.
 *
 * Renders one ambient bar in `conversation.input.dock`, directly above the
 * composer, and reads `/peak-guard/state` from the host every few seconds.
 * The bar changes shape with the host phase:
 *
 *   recheck    reminder: peak starts soon, re-check in N minutes
 *   confirm    10-minute countdown + "I'll wrap up myself" button
 *   waitIdle   waiting for every session in the affected workspaces to finish
 *   done       outcome line (wrap-up sent / cancelled / finished in time)
 *
 * This file is plain JavaScript executed by the client module loader, so it
 * builds elements with React.createElement (no JSX). Text follows the browser
 * language; Chinese comes first. Styling uses only host theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-guard',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React

    const POLL_MS = 8000
    const DONE_VISIBLE_MS = 120_000

    const zh = () => String(navigator.language || '').toLowerCase().startsWith('zh')
    const text = (cn, en) => (zh() ? cn : en)
    const frag = (...children) => React.createElement(React.Fragment, null, ...children)
    const strong = (value) => React.createElement('strong', null, value)

    const TOKENS = {
      surface: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      label: 'var(--dsw-alias-label-primary)',
      labelSoft: 'var(--dsw-alias-label-secondary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    }

    function formatAgo(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      const mm = minutes < 10 ? `0${minutes}` : `${minutes}`
      const ss = seconds < 10 ? `0${seconds}` : `${seconds}`
      return `${mm}:${ss}`
    }

    function clockOf(iso) {
      const date = new Date(iso)
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}`
    }

    function useGuardState() {
      const [snapshot, setSnapshot] = useState(null)
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        const load = async () => {
          try {
            const response = await fetch('/peak-guard/state', {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            })
            if (!response.ok) return
            const data = await response.json()
            if (alive.current) setSnapshot({ data, fetchedAt: Date.now() })
          } catch {
            // a transient fetch failure keeps the previous snapshot
          }
        }
        void load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [])
      return snapshot
    }

    function useTicker(active) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => force((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [active])
      return undefined
    }

    function Button({ label, onClick, disabled, tone }) {
      return React.createElement(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: {
            appearance: 'none',
            cursor: disabled ? 'default' : 'pointer',
            padding: '3px 10px',
            borderRadius: 8,
            border: `1px solid ${TOKENS.borderStrong}`,
            background: 'transparent',
            color: tone === 'brand' ? TOKENS.brand : TOKENS.label,
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            opacity: disabled ? 0.55 : 1,
          },
        },
        label,
      )
    }

    function Dot({ color }) {
      return React.createElement('span', {
        'aria-hidden': true,
        style: {
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flex: '0 0 auto',
        },
      })
    }

    function formatTokens(value) {
      return Number(value || 0).toLocaleString('zh-CN')
    }

    function PeakGuardBar() {
      const snapshot = useGuardState()
      const [confirmed, setConfirmed] = useState(false)
      const [hidden, setHidden] = useState(false)
      const [doneShownAt, setDoneShownAt] = useState(0)
      const occurrence = snapshot?.data?.occurrence ?? null
      const phase = occurrence?.phase ?? null
      useTicker(phase === 'confirm' || phase === 'lead')

      useEffect(() => {
        if (phase !== 'done') {
          setDoneShownAt(0)
          setHidden(false)
          return
        }
        setDoneShownAt((previous) => (previous === 0 ? Date.now() : previous))
      }, [phase, occurrence?.outcome])

      if (snapshot === null) return null
      if (hidden) return null

      const block = snapshot.data.block ?? null
      const blockActive = block?.enabled === true && block?.active === true
      const overLimit = (snapshot.data.sessions ?? []).some(
        (session) => session.overThreshold === true,
      )
      const lastBlockRecent =
        block?.lastBlock !== null &&
        block?.lastBlock !== undefined &&
        Date.now() - Date.parse(block.lastBlock.at) < DONE_VISIBLE_MS
      if (occurrence === null && !(blockActive && (overLimit || lastBlockRecent))) return null
      if (
        occurrence !== null &&
        phase === 'done' &&
        doneShownAt !== 0 &&
        Date.now() - doneShownAt > DONE_VISIBLE_MS
      ) {
        return null
      }

      const serverNow = Date.parse(snapshot.data.now)
      const virtualNow = serverNow + (Date.now() - snapshot.fetchedAt)
      const peakClock = occurrence === null || occurrence.peakAt === null ? '' : clockOf(occurrence.peakAt)
      const nextPeakClock = snapshot.data.nextPeakAt === null ? '' : clockOf(snapshot.data.nextPeakAt)

      let dot = TOKENS.warn
      let body
      let action = null

      if (occurrence === null) {
        const lastBlock = block?.lastBlock ?? null
        dot = TOKENS.error
        if (lastBlock !== null && lastBlockRecent) {
          body = frag(
            text('峰时已拦截一次：该会话累计已用 ', 'Blocked once at peak: that session has used '),
            strong(formatTokens(lastBlock.tokens)),
            text(' tokens', ' tokens'),
          )
        } else {
          body = frag(
            text('峰时拦截已启用：累计超过 ', 'Peak block is on: sessions over '),
            strong(formatTokens(block.threshold)),
            text(' tokens 的会话会被拒绝', ' tokens are rejected'),
          )
        }
        action = React.createElement(Button, {
          label: text('知道了', 'dismiss'),
          onClick: () => setHidden(true),
        })
      } else if (phase === 'lead') {
        const remaining =
          peakClock === '' ? '' : formatAgo(Date.parse(occurrence.peakAt) - virtualNow)
        body = frag(
          text('还有 ', 'in '),
          strong(remaining || '--:--'),
          text(' 进入峰价 ', ' until peak pricing at '),
          strong(peakClock),
          ' · ',
          text(
            '每 5 分钟检查一次，有任务在跑会提醒你收尾',
            'checked every 5 minutes; you will be asked to wrap up if a task is running',
          ),
        )
      } else if (phase === 'confirm') {
        const remaining =
          occurrence.confirmUntil === null
            ? ''
            : formatAgo(Date.parse(occurrence.confirmUntil) - virtualNow)
        dot = TOKENS.error
        body = frag(
          text('还有任务在跑，峰价', 'A task is still running; peak pricing'),
          ' ',
          strong(peakClock),
          ' ',
          text('开始', 'starts'),
          ' · ',
          text('倒计时', 'countdown'),
          ' ',
          strong(remaining),
          ' · ',
          text(
            '不点确认的话，等会话跑完会自动代发收尾口令',
            'without confirmation the wrap-up phrase is sent after the run finishes',
          ),
        )
        action = React.createElement(Button, {
          tone: 'brand',
          label: confirmed ? text('已确认', 'confirmed') : text('我来收尾', "I'll wrap up"),
          disabled: confirmed,
          onClick: async () => {
            try {
              await fetch('/peak-guard/confirm', { method: 'POST', credentials: 'same-origin' })
              setConfirmed(true)
            } catch {
              // the next poll reflects the real state anyway
            }
          },
        })
      } else if (phase === 'waitIdle') {
        const running = (snapshot.data.sessions ?? []).filter(
          (session) => session.status === 'running',
        )
        body = frag(
          text('收尾待命：等这些会话跑完', 'Wrap-up armed: waiting for these sessions to finish'),
          ' ',
          strong(String(running.length)),
          ' ',
          text('个运行中', 'running'),
          ' · ',
          text('全部结束后自动代发一次收尾口令', 'one wrap-up phrase is sent once all are idle'),
        )
        action = React.createElement(Button, {
          label: text('隐藏', 'hide'),
          onClick: () => setHidden(true),
        })
      } else {
        const outcome = occurrence.outcome
        if (outcome === 'wrap-sent') {
          dot = TOKENS.ok
          body = frag(
            text('已代发收尾口令：', 'Wrap-up phrase sent:'),
            strong(snapshot.data.wrapPhrase),
          )
        } else if (outcome === 'confirmed-by-user') {
          dot = TOKENS.ok
          body = text('已按你的确认取消自动收尾', 'Auto wrap-up cancelled as you confirmed')
        } else if (outcome === 'finished-before-recheck') {
          dot = TOKENS.ok
          body = text(
            '任务在复查前已经跑完：只提醒，没有代发',
            'The task finished before the re-check: reminder only',
          )
        } else if (outcome === 'wrap-failed') {
          dot = TOKENS.error
          body = text(
            '自动收尾没发出去，请手动说一句收尾口令',
            'Auto wrap-up failed; please send the phrase yourself',
          )
        } else {
          dot = TOKENS.warn
          body = text(
            '峰价已经开始：本次只提醒，没有代发',
            'Peak pricing has started: reminder only this time',
          )
        }
        action = React.createElement(Button, {
          label: text('知道了', 'dismiss'),
          onClick: () => setHidden(true),
        })
      }

      const nextPeakHint =
        nextPeakClock !== '' && phase !== 'done'
          ? React.createElement(
              'span',
              { style: { color: TOKENS.labelSoft, fontSize: 12, whiteSpace: 'nowrap' } },
              text('下次峰价 ', 'next peak ') + nextPeakClock,
            )
          : null

      return React.createElement(
        'div',
        {
          role: 'status',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '0 0 6px',
            padding: '6px 10px',
            borderRadius: 10,
            border: `1px solid ${TOKENS.border}`,
            background: TOKENS.surface,
            color: TOKENS.label,
            fontSize: 13,
            lineHeight: '20px',
          },
        },
        React.createElement(Dot, { color: dot }),
        React.createElement('span', { style: { flex: '1 1 auto' } }, body),
        nextPeakHint,
        action,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'peak-guard-bar',
              order: 20,
            },
            PeakGuardBar,
          ),
        )
      },
    }
  },
})
