# dsh-memory-optin

给 DSH 加一个「这个对话要不要进全局记忆」的开关，就在输入框工具行里、权限选择器旁边。
**默认不进**：你不点它，这个对话就不会被写进任何地方。

## 装上它

把本仓库克隆到任意路径，然后在 DSH 的插件管理里按 `file:` 路径安装成 bundle——
安装目标写 `file:<你的路径>/dsh-memory-optin`，装完重启 DSH。

手动做法等价于两步：往目标 profile 的 `package.json` 里加依赖
`"dsh-memory-optin": "file:<你的路径>/dsh-memory-optin"`，再把 `dsh-memory-optin` 加进同一个文件的
`dsh.profile.bundles` 数组，然后 `pnpm install` 并重启。

装好后输入框工具行左侧会多一个「💤 记忆」按钮，默认不亮。

## 它做什么

| 方向 | 行为 |
|---|---|
| 读（注入） | 每轮把全局记忆里最近的若干条注入系统提示词，任何会话都能读到 |
| 写（捕获） | **只有你打开开关的会话**才会被记账；写进去的是模型压缩过的一行行结论，不是原始对话 |

开关状态按会话保存，重启后还在。

## 三个开关入口

1. **输入框里的记忆按钮**（主入口）——`💤 记忆` = 不进；点一下变 `🧠 记忆·开`。
2. **`/memory` 命令**——`/memory on|off|status|list`。
3. **配置文件**——`enabled` 关掉就是整个插件不注入也不生效。

## 数据在哪

```
~/.dsh/dsh-memory-optin/
├── sessions.json   每个会话的开关（默认关，没打开过就不写）
└── memory.jsonl    全局记忆，一行一条 JSON
```

`memory.jsonl` 一行长这样：

```json
{"at":1791479200000,"sessionId":"session-xxxx","text":"- 决定了用插件而不是 skill 实现全局记忆"}
```

想清空记忆就直接删 `memory.jsonl`；想撤销某个会话的开关就编辑 `sessions.json`。

## 摘要怎么来的

回合收尾时把本轮攒下的对话交给模型压成最多三条、每条一行的结论。
触发点挂在 `session/event` 的 `turn/end` 上——那是本插件里**唯一有硬证据**能收到的事件
（openviking 靠它攒了几千条待写）；`agent/turn-stopping` 只当兜底。两者都调同一个
`flushTurn()`，缓冲取走即删，所以重复触发幂等。

这一趟**故意不阻塞回合收尾**——一发即忘，失败只记日志，不让你为记忆多等时间。

模型路由复用本会话真实用过的那一条（从 `agent/request` 拿到），拿不到就退回默认模型。

### 出问题时看哪里

`POST /memory-optin/api/debug` 会吐出链路各步的计数：

```json
{"build":"diag-1","enabledIds":[],"seenSessionIds":[],"buffers":[],"routes":[],
 "diagnostics":{"events":0,"userMessages":0,"assistantMessages":0,"turnStopping":0,
                "summarizeAttempts":0,"summarizeFailures":0,"lastError":""}}
```

断在哪一步一目了然：`events` 为 0 就是事件根本没收到；`assistantMessages` 为 0 是过滤条件写错了；
`summarizeFailures` 非 0 就看 `lastError`。`build` 是"进程有没有加载到你改的那份代码"的探针，
详见下一节。

## 改这个插件时注意（踩过的坑）

DSH 那份 `pnpm-workspace.yaml` 设了 `nodeLinker: hoisted`，于是本地 `file:` 依赖**不是软链，
而是硬链接拷贝**。改完源码有两步，缺一步就会对着旧代码调半天：

```powershell
node tools/sync.mjs    # 1. 把 lib/ 和 client/ 同步进运行时那份拷贝
# 2. 完全退出并重开 DSH —— 进程里已加载的 ESM 模块不会被换掉
```

判断自己是不是在对着旧代码：`/memory-optin/api/debug` 返回的 `build` 字段。
它跟源码里那个常量对得上，才说明进程真的换了模块。只重启不同步、或者只同步不重启，
两种情况都会让你看到旧行为，而且**没有任何报错**。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 整个插件总开关 |
| `injectLimit` | `6` | 每轮注入几条最近的记忆；`0` = 不注入 |
| `injectMaxChars` | `1200` | 注入段字符上限 |
| `summarize` | `turn` | `turn` = 每轮收尾摘要一次；`off` = 只攒不摘 |
| `summarizeMaxInputChars` | `8000` | 单次摘要的输入字符上限 |

## 实现要点（给自己以后看）

- **为什么必须是插件**：开关要长在输入框里（客户端槽位）、状态要跨会话落盘、
  捕获与注入要分别挂在 `session/event` 和 `systemPrompt` 上。这三件事里没有一件是
  skill、纯提示词或一个工具函数能做的。
- 开关**不用会话投影**：投影没有写入 API，`apply` 还必须是同步纯函数，装不下一次鼠标点击。
  所以状态由插件自己持有、按 sessionId 落盘。
- 客户端往 `conversation.input.left` 注册；该槽位的 `standardProps` 里有 `sessionId`。
- 客户端与宿主之间走宿主自己的两个 POST 路由（`/memory-optin/api/state`、`/set`），
  不碰 typert/Remote 那一套。
- 捕获的事件：`user/message`（只收 `source.kind === 'user'` 的，注入的 AGENTS.md 之类不算）
  与 `assistant/message`（只取 `text` 块）。

## 已知边界

- 摘要质量取决于模型；想把关就设 `summarize: off`，然后自己在对话里说「记住…」——
  但此时插件只负责攒，不负责挑。
- 注入永远是开的（除非 `enabled: false`）。这是有意的：记忆只写不读等于没有。
- 记忆是纯文本追加，没有向量检索、没有去重。条目多了以后注入的是最近 N 条，
  不是最相关的 N 条。真正需要相关性时再上检索。
