# dsh-peak-guard

> ⚠️ **Not fully tested yet** (version `0.0.1`). Verify it yourself before relying on it.

Peak/off-peak price guard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

1. **Reminder 30 minutes before peak pricing** — evaluated against each provider's own clock.
2. **Auto wrap-up before peak** — if a turn is still running, re-check after 5 minutes, then show a
   10-minute countdown. Without confirmation, the wrap-up phrase is sent once per workspace, only
   after every top-level session in that workspace is idle.
3. **Peak block for long sessions** — optional: during peak hours, a session whose cumulative token
   usage exceeds the threshold has its next step rejected.

It does not write your project summary. Your project's own rules decide what the phrase triggers;
this plugin only delivers it at the right moment.

## Requirements

- DeepSeek Harness `0.2.1-rc.2` or newer (`sessionController.prompt`, `agent/pre-step`, `agent/status`).
- Optional: `dsh-peakrate` for the peak/off-peak catalog. Without it the plugin falls back to
  `~/.dsh/dsh-peakrate/pricing.json`; with neither it stays silent instead of failing.

## Install

```bash
dsh plugin --profile <profile> add <this-repo-url>
```

Restart `dsh web`. The plugin appears as “Peak Price Guard”.

## Configuration

```yaml
- id: peak-guard
  config:
    enabled: true
    leadMinutes: 30
    recheckMinutes: 5
    confirmMinutes: 10
    wrapPhrase: 今天先到这里，现在收工
    blockTokens: 2000000
    blockLongConversations: false
    clockOffsetMinutes: 0
    profileIds: [deepseek-v4]
```

See `README.zh.md` for the full table and behaviour notes.

## Debug endpoints

Local-only, same-origin/loopback fenced:

| Endpoint | Purpose |
|---|---|
| `GET /peak-guard/state` | current phase, next peak, per-session tokens |
| `POST /peak-guard/clock {"minutes": N}` | shift the simulated clock |
| `POST /peak-guard/reset` | clear the current occurrence |
| `POST /peak-guard/check {"sessionId": "..."}` | token total and block decision for one session |

## Tests

```bash
node --test test/schedule.test.mjs test/guard.test.mjs
```

## License

MIT
