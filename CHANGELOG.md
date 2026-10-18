# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.0.1] - 2026-10-19

> ⚠️ **功能未经过充分测试。** 版本号改成 `0.1.1` 时删除本提示。

### 新增

- 峰价前 30 分钟提醒（按 `dsh-peakrate` 目录里的峰谷时段判定，支持时区与法定节假日）。
- 提醒后 5 分钟复查、10 分钟倒计时确认；未确认则在**该工作区所有顶层会话空闲后**
  自动代发一次收尾口令。
- 按 `session.header.cwd` 分组，不同工作区各自收尾；子会话不参与。
- 峰时拦截：累计 token 超过阈值时由 `agent/pre-step` 拒绝下一步（默认关闭）。
- composer 上方横幅：提醒 / 倒计时 / 收尾待命 / 已代发 / 拦截状态。
- 调试接口与模拟时钟，便于不等待真实时段地验证整条链路。
