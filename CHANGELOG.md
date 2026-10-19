# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.0.1] - 2026-10-19

> ⚠️ **功能未经过充分测试。** 版本号改成 `0.1.1` 时删除本提示。

### 新增

- 峰价前 30 分钟提醒（按 `dsh-peakrate` 目录里的峰谷时段判定，支持时区与法定节假日）。
- 峰前半小时**横幅常驻**（不再是一闪而过），后台每 5 分钟检查一次；
  中途才跑起来的任务同样会触发 10 分钟倒计时。
- 10 分钟倒计时确认；未确认则在**该工作区所有顶层会话空闲后**自动代发一次收尾口令。
- 按 `session.header.cwd` 分组，不同工作区各自收尾；子会话不参与。
- 峰时拦截：累计 token 超过阈值时由 `agent/pre-step` 拒绝下一步（默认关闭）。
- composer 上方横幅：提醒 / 倒计时 / 收尾待命 / 已代发 / 拦截状态。
- 调试接口与模拟时钟，便于不等待真实时段地验证整条链路。

### 修复

- Harness 重启后 `agents` 服务尚未就绪时守护会直接退出，导致整条链路不工作
  （表现为 `/peak-guard/state` 返回 404）。现在改为先启动、服务晚到就在下一次心跳重试。
- `sessionController.prompt` 的 `signal` 参数必填，之前传空值会抛异常。

### 新增（调试）

- `POST /peak-guard/cancel`：取消本轮，不再提醒也不代发。
- 审计日志：关键动作追加到 `~/.dsh/peak-guard/events.jsonl`，
  `GET /peak-guard/history?limit=N` 可查最近记录。
