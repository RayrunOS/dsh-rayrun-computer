# 云上 DSH 与本地 DSH 一致方案（本地权威）

> 决策：**本地 DSH 是唯一权威**。云上 DSH 是本地 profile / workspace 的**只读投影**和**任务执行 worker**；会话、配置、凭证、文件合并都以本地为准。
>
> 云端入口：Rayrun 官网 `http://rayrunos.com/`；托管 API `https://api.rayrunos.com/v1`（`rayrunos.com/v1` 是官网 SPA，不是 API）。
>
> 目标：云上 worker 与本地在版本、能力、工作区上保持一致；本地会话把任务委托给云上执行，再把结果写回本地会话。云上不成为第二套主环境，也不需要把本地 UI 切到云端。

---

## 1. “一致”的四个层面（本地权威）

| 层面 | 方向 | 验收 |
| --- | --- | --- |
| 运行时 | 本地版本 → 云上同版本 | 两端 `dsh --version`、Node 主版本一致 |
| 能力 | 本地 profile → 云上只读投影 | profile bundles、插件、presets、skills、MCP、模型路由一致（去掉密钥/路径差异） |
| 工作区 | 本地推送 → 云上执行 → 本地合并 | `HEAD` + dirty patch hash 一致；云上改动以 diff 回传本地 |
| 会话/界面 | 只在本地 | 本地 session log 是唯一 durable source；云上 worker 日志可丢弃 |
| 凭证 | 只在本地 | 云上只拿到 scoped 模型密钥；本地 `~/.dsh/.credentials.yaml` 不出本机 |

“一致”不等于“双活”。本方案明确：

- **强一致**：版本、profile、workspace（单向投影）；
- **本地权威**：会话、配置编辑、文件合并、凭证；
- **云上可丢弃**：worker 会话日志、临时构建目录、缓存。

---

## 2. 架构

```
┌──────────────────────────── 本地 DSH（权威）─────────────────────┐
│  session log（唯一 durable source）                              │
│  profile / workspace / credentials                               │
│  ┌─ 云电脑面板：provision / sync / status / delegate ─────────┐  │
│  │                                                             │  │
│  │  rayrun_dsh / rayrun_agent  ── Rayrun REST API ────────────┼──┼──┐
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘  │
                                                                      │
┌──────────────────────── 云上沙箱（worker）─────────────────────────┐│
│  profile 投影（read-only，cloudMode: true）                        ││
│  workspace 镜像（push → run → diff 回传）                          ││
│  dsh headless / ACP worker（与本地同版本、同 profile）             ││
│  └─ 可选：dsh web（仅调试；需要 ingress，不是主路径）              ││
└────────────────────────────────────────────────────────────────────┘│
                                                                      │
        POST /sandboxes/{id}/prompts + GET /events（SSE）  ◄──────────┘
```

### 关键取舍

- **主传输不需要 ingress**：优先使用 Rayrun 的 agent prompt + SSE（现有的 `rayrun_agent` 通道）。云上 DSH 作为沙箱内的 agent 接收任务，本地会话把 prompt/结果记成 tool result。这样当前未配置 `RAYRUN_INGRESS_DOMAIN` 的部署也能工作。
- **云上 Web 只做调试**：需要 ingress；不是“一致”的前置条件。
- **云上 profile 只读**：所有配置修改在本地完成，重新导出/推送；云上不允许 UI 改 profile。
- **云上会话是 worker 缓存**：机器销毁即丢；本地 session log 才是历史。

---

## 3. 同步什么、不同步什么

### 3.1 Profile：本地 → 云上（单向、只读）

从本地 `~/.dsh/profiles/<profile>` 生成 **cloud projection**：

```
profile-cloud/
  package.json          # link: 改 file: tarball
  pnpm-lock.yaml        # 干净环境生成
  pnpm-workspace.yaml
  cordis.yml
  cordis.patch.yml      # secret scan；cloudMode: true
  plugins/
    dsh-plugin-rayrun-computer-2.x.x.tgz
  skills/               # 仅用户自装 skills
  bootstrap.sh
```

- 云上 DSH 启动时指向这份 profile；文件权限设为只读（或启动后校验 hash，发现变更则拒绝启动/告警）。
- 每个 profile 带 `profileRev`（内容 hash）；云上机器记录 `profileRev`，本地每次委托前比对，漂移则重新推送。
- 云上 `cloudMode: true`：隐藏“云上电脑/本地电脑”切换、隐藏云电脑创建/销毁，避免递归；保留只读状态或完全隐藏。
- `cordis.patch.yml` 不含 token/secret；模型 key 通过 Rayrun 凭证/环境变量注入。
- 基础 `@deepseek-ai/*` 包由云上 DSH 安装提供；只有本地插件打包上传。

### 3.2 Workspace：本地推送 → 云上执行 → 本地合并

1. 任务开始前：本地 `git` 状态 + dirty patch + 未跟踪文件 tar 推送到云上；
2. 云上 worker 在镜像 workspace 内执行；
3. 任务结束：云上 `git diff`/文件 tar 回传；
4. **本地是合并权威**：本地 review/apply，冲突由本地解决；
5. 全程单 writer lock：云上任务运行期间，本地对同一 workspace 的写操作提示冲突或排队；
6. 大文件/依赖目录排除，必要时走 Rayrun files API 分块。

没有 git remote 时：tar + sha256 manifest；仍然只以本地为合并权威。

### 3.3 不同步

- `~/.dsh/.credentials.yaml`、`.env`、SSH 私钥、浏览器数据；
- 本地/云上的 sessions 目录（本地 session log 只在本机；云上 worker 日志可丢弃）；
- `node_modules`、构建产物、缓存、日志、attachments（按需回传）。

---

## 4. 云上 worker 的运行方式

### 4.1 版本与 profile

- 云上镜像 `deepseek-harness@1` 自带 DSH；Phase 0 校验 `dsh --version`、Node、profile 路径、agent entrypoint。
- 版本不一致时：在镜像内安装固定版本，或制作固定版本运行包；禁止“版本漂移仍宣称一致”。
- 云上启动参数指向只读 profile（具体入口以镜像/`dsh --help` 为准）。
- 如果镜像的 agent 入口本身就是 DSH（headless/ACP），优先复用 Rayrun 的 `POST /prompts` + `GET /events`，本地不需要 ingress。

### 4.2 启动与健康检查

- 机器 create/start/resume 后，bootstrap 脚本：
  1. 解压 profile 投影；
  2. 安装本地插件；
  3. 校验 `dsh --version` 和 profile hash；
  4. 启动 DSH worker（headless/ACP）；
  5. 写 ready 标记。
- 健康检查：worker 进程存在、profile hash 匹配、workspace 挂载正确、模型域名 egress 放行。
- 崩溃重启；日志轮转；机器 stop 后 worker 停止，磁盘保留。

### 4.3 云上 DSH Web（可选）

- 仅用于调试/观察，不作为主界面。
- 需要 `RAYRUN_INGRESS_DOMAIN`；发布端口用 `visibility: token`，再叠加 DSH 自身 token。
- 没有 ingress 时不影响核心委托链路（prompt + SSE）。

---

## 5. 任务路由：本地会话如何用云上 worker

### 5.1 本地电脑

完全本地：本地 session、本地工具、本地 workspace。

### 5.2 云上电脑（本地权威）

1. 本地会话进入“云上电脑”模式；
2. 插件 `rayrun_dsh`（或现有的 `rayrun_agent`）：
   - ensure 云上机器；
   - 比对/推送 profile 投影；
   - 推送 workspace；
   - 把任务 prompt 发给云上 DSH worker（Rayrun agent API）；
   - 流式接收 SSE，把进度/结果写入本地 tool result；
3. 任务结束：回传 diff，本地合并；
4. 本地 session log 记录：prompt、worker 事件摘要、结果、回传文件；
5. 云上 worker 的 session 日志不作为权威，可在机器销毁时丢弃。

### 5.3 与当前实现的差距

当前“云上电脑”只是给本地 Agent 注入一段 prompt，让它用 `rayrun_*` 工具。升级为：

- 本地 Agent 的云上任务应优先调用 **`rayrun_dsh`**（或 `rayrun_agent`）把整段任务委托给云上 DSH，而不是零散 `rayrun_exec`；
- 委托前由插件保证 profile/workspace 已同步；
- 结果写回本地会话；
- 云上 DSH 不可用时明确失败，回退本地模式。

### 5.4 为什么不做云上 Web 主界面

- 本地权威要求会话/配置/合并都在本地；云上 Web 会成为第二套 UI/状态；
- 当前部署没有 ingress，云上 Web 不可达；
- 本地已有完整 DSH UI，没必要切换。

### 5.5 本地上下文如何交给云上 worker

先把“上下文”拆成四类，分别处理：

| 上下文 | 来源 | 交给 worker 的方式 |
| --- | --- | --- |
| 会话/决策 | 本地 session log、compaction 摘要、最近 turn、工具结果 | `conversation.md` + `handoff.md` |
| 工作区 | git HEAD、dirty patch、未跟踪文件 | `workspace.patch` + `manifest.json` + 实际文件推送 |
| 能力 | 本地 profile、插件、skills、模型路由 | cloud profile 投影 + `profile.json` |
| 任务状态 | 目标、约束、已做决策、未决问题、验收 | `handoff.md`（模型 brief + 自动清单） |

#### 默认方案：Context Pack（L1，推荐）

每次委托前，在 workspace 下生成：

```
.dsh/handoff/<taskId>/
  handoff.md          # 目标 / 约束 / 已决策 / 未决问题 / 验收标准
  conversation.md     # 最近 N turn + 最新 compaction 摘要 + 关键工具结果
  workspace.patch     # git diff --binary
  manifest.json       # HEAD、dirty hash、未跟踪文件、文件 sha256
  profile.json        # profileRev、插件/skills 版本、模型路由
  refs/               # 需要 worker 重点看的少量文件（可选）
```

worker 的 prompt 只做一件事：

> 读取 `.dsh/handoff/<taskId>/handoff.md` 及其引用文件，在 workspace 内完成任务；结果写到 `.dsh/results/<taskId>/`，不要修改 handoff 目录。

这样上下文不依赖“一次把长对话塞进 prompt”，而是变成 worker 可读、可复查的文件。

**Context Pack 的生成**：

- 自动部分：
  - 本地 session log / projection 里最近的 turn、compaction 摘要、关键 tool result；
  - `git diff --binary`、未跟踪文件 tar、文件 manifest；
  - profileRev、插件/skills 版本、模型路由。
- 模型部分：本地 Agent 在调用 `rayrun_dsh` 时提交一份 `brief`（目标、约束、决策、未决问题、验收）。这部分是模型对自己上下文的显式提炼。
- 自动清单校验：缺目标/验收/workspaceRev/profileRev 时拒绝委托或明确警告，避免“只有一句 prompt”。
- 预算与脱敏：大工具输出改成引用/摘要；token/secret/`.env` 扫描后剔除；限制 pack 大小。

#### 全量保真：Session Fork（L2）

需要完整对话时：

1. 本地在某个 seq 上 fork 出子 session（本地父 session 不动）；
2. 导出子 session 的 JSONL + attachments + workspace；
3. 云上以同一 DSH 版本 resume 这个子 session；
4. worker 写子 session；结束后回传子 session 日志 + diff；
5. 本地把它作为**一个分支**导入/查看；父 session 仍是权威。

注意：路径重写、附件、session 格式版本、工具结果里的本地绝对路径；只用于高风险/长任务，不作为默认。

#### 实时增量：Context Broker（L3）

- 保持 cloud worker session 存活，本地每轮发送 **delta pack**（新增用户消息、决策、文件变化）；
- worker 需要额外上下文时，通过结构化事件（或 `ask_user_question`）请求；本地把请求变成 UI 提示，回答/上传文件后再发 delta；
- worker 的 session 仍是缓存；本地 session log 是唯一权威；机器丢失时从本地日志 + workspace + 最近结果重建。

#### 保证一致性的机制

- **版本三元组**：`sessionSeq`、`workspaceRev`、`profileRev` 写入 handoff；worker 首次响应回显，不匹配则拒绝/重推。
- **单向写回**：worker 不能写本地 session log；结果以 tool result/事件回到本地，由本地写入。
- **必填清单**：目标、约束、已决策、未决问题、文件清单、验收标准、workspaceRev、profileRev；缺项不委托。
- **可重建**：worker 丢失后，仅凭本地 session log + workspace + 最近结果就能重新拉起。
- **不发送**：本地凭证、`.env`、SSH key、浏览器数据；session 日志中的敏感 tool result 先脱敏。

---

## 6. 插件改造点

### Host

新增 `lib/cloud-dsh.js`：

- `exportProfileProjection()`：生成本地 profile 的 cloud 只读投影；`link:` 改 `file:`；secret scan；`cloudMode: true`。
- `ensureWorker(machineId)`：bootstrap（解压、安装插件、校验版本/profile hash、启动 worker）。
- `syncWorkspace(machineId, direction)`：push/pull diff；本地合并。
- `delegate(machineId, prompt)`：调用 Rayrun agent prompt/SSE，聚合事件/结果。
- `status(machineId)`：worker 状态、profileRev、workspaceRev、ingress（可选）。

RPC：

```
cloud.profile.export
cloud.worker.ensure / status / stop
cloud.workspace.push / pull
cloud.task.delegate
```

### 工具

新增 `rayrun_dsh`：

```
action: ensure | sync | delegate | status
sandbox: name/id
prompt: string   (delegate 时)
```

本地 Agent 在“云上电脑”模式下优先用它；`rayrun_exec/files/agent` 保留为细粒度/回退工具。

### 面板与切换

- 机器卡片/详情增加「云上 DSH」状态：未投影 / 同步中 / 就绪 / 版本不匹配 / 需重建。
- 提供“同步 profile / 同步 workspace / 测试委托”。
- 输入区切换：
  - 本地电脑 → 本地；
  - 云上电脑 → 委托云上 DSH worker；本地会话仍是主会话；
  - 失败时提示，不静默切本地。
- 云上 profile：`cloudMode: true`，隐藏递归的云电脑切换/创建。

---

## 7. 分阶段实施

### MVP（建议 3–5 天，无 ingress 依赖）

1. 本地 profile 导出为 cloud 投影（含本地插件 tarball、secret scan、`cloudMode`）。
2. 云上 bootstrap + 版本/profile hash 校验 + worker 启动。
3. workspace push（git + dirty patch）。
4. 用 Rayrun agent prompt/SSE 把任务委托给云上 DSH；本地 session 记录结果；回传 diff。

验收：本地会话是唯一记录；云上执行同一 profile/workspace；任务结果写回本地；不需要 ingress。

### P0 基线（0.5–1 天）

- 云上 `dsh --version`、Node、`dsh --help`、agent entrypoint、profile 路径、prompt API 行为。
- 确认云上 agent 是否就是 DSH、是否支持流式事件、是否读取 `~/.dsh/profiles`。
- 记录版本/profile 基线。

### P1 Profile 投影与 bootstrap（1–2 天）

- 导出/打包/secret scan；link 改写；只读权限；profileRev。
- 云上安装插件、校验版本/hash、启动 worker。
- 验收：profile 包清单/配置与本地一致；云上不能改 profile。

### P2 Workspace 同步（1–2 天）

- push/pull diff；lock；hash 校验；冲突提示。
- 验收：HEAD + dirty patch 一致；云上 diff 可回传本地合并。

### P3 任务委托与上下文交接（3–4 天）

- Context Pack 生成：`handoff.md`、`conversation.md`、`workspace.patch`、`manifest.json`、`profile.json`。
- `rayrun_dsh` 工具 + `cloud.task.delegate`；首次全量 pack，后续 delta；SSE 事件聚合；本地 tool result。
- 版本三元组（sessionSeq / workspaceRev / profileRev）校验；必填清单缺项拒绝委托。
- 本地 prompt context 改为“委托云上 DSH worker，本地汇总”。
- 验收：worker 首响应回显 revs 且匹配；云上模式任务在云上执行；本地日志可追溯；云上不可用明确失败。
- L2 session fork 可在 P4 评估，不作为首版默认。

### P4 交互增强与硬化（2–4 天）

- 评估 ACP/终端 PTY 做多轮流式；仍然本地权威。
- 可选：云上 DSH Web 调试入口（ingress token）。
- 安全审计、自动 stop、成本提示、回退演练。

---

## 8. 安全与成本

- **凭证**：本地密钥不出本机；云上模型 key 单独签发、限额、按机器注入。
- **Profile**：secret scan；云上只读；启动前 hash 校验；拒绝被篡改的 profile。
- **Workspace**：同步前一刀切排除 `.env`/私钥；本地合并前 review diff。
- **传输**：Rayrun API Bearer token；ingress 仅 token（如果启用 Web）；日志脱敏。
- **成本**：worker 按需启动；空闲自动 stop；destroy 前提示回传产物；展示预估费用。
- **审计**：bootstrap、sync、delegate、destroy 记录机器/时间/操作者。

---

## 9. 风险与回退

| 风险 | 影响 | 回退 |
| --- | --- | --- |
| 云上 agent 不是 DSH / 不读 profile | 无法一致 | Phase 0 确认；改用 headless exec 或自带 worker 入口 |
| 版本漂移 | 插件/协议不兼容 | 固定版本；profileRev + version 校验失败即拒绝委托 |
| workspace 合并冲突 | 本地覆盖 | 本地 review/apply；lock；git 三方合并 |
| 云上创建失败（当前 `ip tuntap`） | 无法启动 | 本地模式继续；错误上报 |
| 无 ingress | 云上 Web 不可用 | 核心链路不依赖；仅调试 Web 受影响 |
| 云上 worker 日志丢失 | 历史缺失 | 本地 session log 是权威；worker 日志可丢弃 |
| 模型 egress 未放行 | 云上 Agent 失败 | 创建时显式 `egress_allow` 模型域名 |

---

## 10. Phase 0 当前探测限制

本次创建 `deepseek-harness@1` 探针机器时，Rayrun 本地开发集群返回：

```
net: tap phase: ip tuntap 失败（fork/exec /usr/sbin/ip: operation not permitted）
```

因此云上镜像的实际 DSH 版本、agent entrypoint、`dsh` 参数尚未验证；方案中的命令以 Phase 0 输出为准。当前本地开发部署也未返回 ingress URL，但这不影响“本地权威 + prompt/SSE 委托”的核心链路。

Phase 0 必须在可用集群上确认：

```bash
dsh --version
node --version
which dsh
dsh --help
ls -la ~/.dsh/profiles
cat ~/.dsh/profiles/*/package.json
# 确认 Rayrun prompt API 是否由 DSH 接管、事件格式是否可用
```

---

## 11. 验收清单

- [ ] 云上/本地 DSH 版本、Node 主版本一致
- [ ] 云上 profile 是本地投影：包、presets、skills、MCP、权限、模型路由一致
- [ ] 云上 profile 只读；profileRev 漂移会被发现/拒绝
- [ ] workspace push 后 HEAD + dirty patch hash 一致
- [ ] 每次委托生成 Context Pack：handoff / conversation / patch / manifest / profileRev
- [ ] Context Pack 通过 secret scan；无本地凭证、`.env`、SSH key
- [ ] worker 首响应回显 sessionSeq / workspaceRev / profileRev，且与本地匹配
- [ ] worker 丢失后可从本地 session log + workspace + 最近结果重建
- [ ] 云上任务通过 prompt/SSE 委托，本地 session log 记录完整
- [ ] 云上 diff 回传本地，本地 review/merge 后才成为权威
- [ ] 云上 profile `cloudMode: true`，无递归云电脑切换/创建
- [ ] 本地模式完全本地；云上不可用明确失败，不静默降级
- [ ] 无本地密钥进入云上；ingress（如启用）仅 token
- [ ] 空闲自动 stop；destroy 前提示产物回传

---

## 12. 仍需确认

1. **委托传输**：首版用 Rayrun 的 agent prompt + SSE（推荐，无 ingress），还是 headless `dsh` exec，或 ACP/PTY？
2. **交互粒度**：首版只做“整段任务委托”，还是需要多轮追问/流式交互？
3. **云上 profile**：`cloudMode: true` 下云电脑面板是只读还是完全隐藏？
4. **集群前提**：`ip tuntap` 何时修复；云上 agent 是否确认由 DSH 接管。

确认后按 P0 → P4 实施；第一步是 profile 投影导出 + Phase 0 版本/传输探测。
