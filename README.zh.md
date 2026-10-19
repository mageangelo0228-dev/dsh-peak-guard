# 峰值守卫 · dsh-peak-guard

> ⚠️ **功能未经过充分测试**（当前版本 `0.0.1`）。请先自行验证再用于重要会话；版本号改成 `0.1.1` 时会删除本提示。

给 DeepSeek Harness 的峰谷价守卫：

1. **峰价前 30 分钟提醒** —— 按 provider 自己的峰谷时钟算，不写死 DeepSeek 的时段。
2. **峰前自动收尾** —— 提醒后如果还有任务在跑，等 5 分钟复查；仍在跑就弹 10 分钟倒计时；
   不确认的话，等该**工作区**所有会话都空闲后，自动代发一句收尾口令，**每个工作区只发一次**。
3. **峰时拦截长会话** —— 可单独开启：峰时累计超过阈值的会话，下一步会被直接拒绝。

> 它不替你的项目写总结。收尾内容由你项目自己的规则决定，本插件只负责「在正确的时机把口令送进去」。

## 依赖

- DeepSeek Harness `0.2.1-rc.2` 或更高（用到 `sessionController.prompt`、`agent/pre-step`、`agent/status`）
- **可选但推荐**：`dsh-peakrate` —— 峰谷数据从它的 `peakrate` 服务读；
  没装时退回读它的磁盘缓存 `~/.dsh/dsh-peakrate/pricing.json`。
  两者都没有时，插件不报错，只是不触发任何提醒。

## 安装

**方式一：从 git 安装**

```bash
dsh plugin --profile <你的profile> add <本仓库地址>
```

**方式二：本地目录**

```bash
git clone <本仓库地址> dsh-peak-guard
dsh plugin --profile <你的profile> add ./dsh-peak-guard
```

装完重启 `dsh web`。插件列表里会出现「峰值守卫」。

## 配置

写在 profile 的 `cordis.patch.yml` 里，覆盖同名 id：

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

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `leadMinutes` | `30` | 峰前多少分钟提醒 |
| `recheckMinutes` | `5` | 提醒后多久复查是否还在跑 |
| `confirmMinutes` | `10` | 倒计时确认框的时长 |
| `wrapPhrase` | `今天先到这里，现在收工` | 自动代发的收尾口令 |
| `blockTokens` | `2000000` | 峰时拦截的累计 token 阈值 |
| `blockLongConversations` | `false` | 拦截开关，默认只提醒 |
| `clockOffsetMinutes` | `0` | 模拟时钟（调试用），0 = 真实时间 |
| `profileIds` | `[deepseek-v4]` | 监控的峰谷档位 id，按顺序取第一个存在的 |
| `history` | `true` | 是否写审计日志 |
| `historyLimit` | `30` | 审计日志只保留最近多少条 |

## 工作方式

```
峰前 30 分钟（例如 08:30，峰价 09:00）
  └─ 横幅常驻，后台每 5 分钟检查一次
        ├─ 没有任务在跑 ─────────► 横幅继续挂着，直到峰价开始
        └─ 有任务在跑 ───────────► 10 分钟倒计时
              ├─ 你点确认 ───────► 取消自动收尾
              └─ 未确认 ─────────► 等工作区全部空闲 → 代发一次收尾口令
```

要点：

- **提醒不是一闪而过**：整个峰前半小时横幅都在，不会因为「当时没在跑」就消失；
- **中途开始的任务也会被抓到**：每 5 分钟检查一次，后面才跑起来的任务同样会触发倒计时；
- **按工作区分组**（`session.header.cwd`），不同工作区各自收尾一次；
- **只发给最后结束的那个会话**；
- **永不打断进行中的轮次**（宁可等到峰时，也不强行收尾）；
- **子会话（subagent）不参与**。

## 调试

宿主暴露几个只在本机可用的调试接口（都有同源/回环信任围栏）：

| 接口 | 用途 |
|---|---|
| `GET /peak-guard/state` | 当前相位、下次峰价、各会话 token |
| `POST /peak-guard/clock {"minutes": N}` | 把模拟时钟拨快 N 分钟 |
| `POST /peak-guard/reset` | 清空当前这一轮状态 |
| `POST /peak-guard/cancel` | 取消本轮（本轮不再提醒、不代发） |
| `POST /peak-guard/check {"sessionId": "..."}` | 查一个会话当前累计 token 与是否会被拦截 |
| `GET /peak-guard/history?limit=50` | 查审计日志（最近 N 条） |

## 审计日志

插件会把关键动作追加到 `~/.dsh/peak-guard/events.jsonl`（一行一个 JSON），
包括：启动、进入峰前窗口、每 5 分钟检查、进入倒计时、确认、取消、
等空闲、代发成功/失败、峰价开始、拦截。

- **只保留最近 `historyLimit` 条（默认 30 条）**，更早的自动丢弃，不会无限增长；
- `history: false` 可关闭写日志（测试用）；
- 换机器/换 profile 时日志跟着 `DSH_HOME` 走。

测试：

```bash
node --test test/schedule.test.mjs test/guard.test.mjs
```

## 已知限制

- **窗口跨午夜**时按下班日归属（目前按当前时刻的星期判断），DeepSeek 的时段不跨午夜，不受影响；
- 活动/促销 override 被当作「非峰时」，不细分倍率；
- 累计 token 取每次调用的 `usage.totalTokens`（缺失时 input+output 相加），
  口径是「账单累计」而不是「当前上下文」。

## 许可

MIT
