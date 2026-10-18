# dsh-peak-guard 开发规则

> 这是「峰值守卫」这个**编程任务**自己的规则文件。工作区级规则在 `E:\ds\AGENTS.md`，
> 本文件只写这个插件项目的约定；两者冲突时，用户最新口头指令优先。

## 一、项目是什么

给 DeepSeek Harness 用的插件，三件事：

1. 峰价前 30 分钟提醒（峰谷数据来自 `dsh-peakrate`）；
2. 峰前自动收尾：提醒 → 5 分钟复查 → 10 分钟倒计时 → **等该工作区全部会话空闲** →
   每个工作区**只代发一次**收尾口令（默认 `今天先到这里，现在收工`）；
3. 峰时拦截：会话累计 token 超阈值时用 `agent/pre-step` 拒绝下一步（默认关闭）。

## 二、文件结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：峰谷判定、状态机、`/peak-guard/*` 路由、pre-step 拦截 |
| `client.js` | 网页半：composer 上方横幅（**纯 JS，不能用 JSX**） |
| `cordis.patch.yml` | bundle 注册行与全部默认配置 |
| `test/*.test.mjs` | `node:test` 单测，不需要安装即可跑 |
| `README.zh.md` / `README.md` | 中文为主，英文镜像 |

## 三、常用命令（复制即可）

```powershell
cd E:\ds\plugins\dsh-peak-guard

# 语法自检
node --check index.js
node --check client.js

# 全部测试
node --test test/schedule.test.mjs test/guard.test.mjs
```

安装/重装走 `plugin_manager` 的 `install_bundle`，**不要**手改 profile 的
`package.json` / `cordis.patch.yml`，也不要手动跑 pnpm。

改了宿主或客户端代码后，用 `plugin_manager set_plugin` 先关再开 `include:peak-guard`
让新代码生效；网页端改动还需要按 F5 刷新页面。

## 四、版本与测试状态（重要）

- 当前版本 **`0.0.1`**，插件描述里带 **「功能未经过充分测试」** 标注。
- **用户说版本号改成 `0.1.1` 时**：把以下位置的提示全部删掉——
  `package.json` 的 description、`locale/zh.json`、`locale/en.json`、
  `README.zh.md`、`README.md`、`CHANGELOG.md`。
- 不要擅自跳版本号；版本号由用户决定。

## 五、归档规则（用户 2026-10-19 定的）

**已归档的文件，除非用户明确说明，否则视为不存在。**
不要主动读取、引用、恢复 `archive\` 目录里的内容；用户点名要时才去翻。

## 六、实现上的坑（踩过的，别再踩）

1. `sessionController.prompt(request, signal)` 的 **`signal` 必填**，传 `undefined` 会抛
   `Cannot read properties of undefined (reading 'throwIfAborted')`。
2. `client.js` 由加载器当**普通 JS**执行，写 JSX 会直接语法错误，用
   `React.createElement` / 自己写的 `frag()`。
3. 进度状态只从会话日志与现有服务推导，**不要新增会话事件类型**（会让会话无法重新打开）。
4. 工作区用 `session.header.cwd` 分组；`header.origin === 'subagent'` 的子会话一律排除。
5. 自动收尾**永不打断进行中的轮次**——宁可等到峰时，也不强推（用户明确要求）。
