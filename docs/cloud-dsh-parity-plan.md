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
5. 全程单 writer lock：云上任务（`rayrun_agent` / `rayrun_exec`）运行期间，本地 `push` 直接拒绝（`workspace_locked`）；`force` 可强行覆盖并丢弃云端文件。锁为进程内状态，Host 重启即失效。
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

### 4.3 云上 DSH Web（可选，实测：可做但要手动开、用完即关）

2026-11-01 实测结论（一次性机器验证后已销毁）：

| 事实 | 结果 |
| --- | --- |
| 发布端口的 API | **不存在**：`/ingress`、`/ports`、`/expose`、`/services` 全部 404；创建时额外传 `ingress: [{port}]` 会被忽略 |
| 唯一的 ingress | 创建时 `remote_desktop: true` 才会发布 6080，且实测 `visibility: "public"`（不是 token） |
| `dsh web` 绑定 | 配置 schema 只接受 `127.0.0.1` / `0.0.0.0`；`0.0.0.0` 被 CLI 明确拒绝（"would expose remote code execution"），所以只能绑 loopback |
| 网关方向 | 网关打的是 guest 私网 IP，loopback 上监听会得到 `502 no service listening on the published port` |

因此可行的调试入口是「把 6080 让给 `dsh web`」：

```bash
# 机器必须创建时带 remote_desktop: true（才会发布 6080）
rayrun-desktop stop                                   # 腾出 6080
dsh --profile web --no-open --host 127.0.0.1 --port 8080   # web 只能绑 loopback
# 用一个临时 TCP 转发把 10.42.0.6:6080 → 127.0.0.1:8080（约 30 行 python asyncio）

# 本地打开 dsh web 日志里打印的
# https://6080-<sandbox-id>.rayrunos.com/?token=<dsh web 打印的 token>
```

实测：带 token 访问返回 303 换 cookie，再请求 `/` 得到 200 + 完整的 DSH Web shell（约 35 KB HTML）。

**安全约束（必须遵守）**

- 这个入口是 **RCE 级**：能操作机器的一切；URL 是 `public`，只要有 token 谁都能用。
- token 等同凭证：不进仓库、不进日志、用完即弃（机器销毁即失效）。
- 只在排障时临时开；用完 kill 转发与 `dsh web`，不要让它在空闲机器上常驻。
- 核心委托链路不依赖它（prompt + SSE），不开完全不影响 P1–P3。

### 4.4 ACP / PTY 评估（决定：不做）

- `dsh acp` 存在（stdio JSON-RPC），但 Rayrun 的 exec 通道不是交互式 stdio：没有持久 stdin，无法维持 ACP 会话。
- PTY 同理：`/exec` 是一次性的命令通道，没有 pty 分配接口。
- 现状的多轮能力由「同 `task_id` 追加 + `questions.md`」提供，已覆盖「需要本地决定就停一轮」的场景；实时人工追问没有产品价值上的必要性。
- 结论：不引入 ACP/PTY；若将来 Rayrun 提供交互式通道，再评估。

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

原先“云上电脑”只是给本地 Agent 注入一段 prompt。现在已经升级为**工具级路由**：

- 云上模式下，Host 的 tools guard 直接拒绝本地 `pwsh` / `bash` / `write` / `edit`（返回明确原因并指向 `rayrun_exec` / `rayrun_files` / `rayrun_workspace` / `rayrun_dsh delegate`），所以本地不可能悄悄执行；
- 读取类工具（`read` / `glob` / `grep` / `read_image`）保持可用，审阅与汇总仍由本地负责；
- 委托链路改为优先 **`rayrun_dsh delegate`**：委托前自动 mirror workspace、校验/重推 profile 投影，交付 Context Pack，回显三元组并取回结果；
- 云上不可用时明确失败，不会静默留在本地；
- 限制：审阅后的 `git apply` 属于本地写入，需要先切回「本地电脑」或由人手动应用。

同名工具的透明远端执行（把 `pwsh` / `read` / `write` 直接代理到云上）当前**没有做**：DSH 的执行绑定在注册的 definition 上，透明代理需要在 agent 作用域内影子注册同名工具并重写执行体，属于独立改造；现有「硬门禁 + 专用云工具」已经能让路由确定。

### 5.4 为什么不做云上 Web 主界面

- 本地权威要求会话/配置/合并都在本地；云上 Web 会成为第二套 UI/状态；
- 云上 Web 需要占用桌面 ingress（见 §4.3），只适合临时排障，不适合当主界面；
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

**已实施（2026-11-01，Phase 0 之后按实测重排）**

| 项 | 状态 | 代码 / 证据 |
| --- | --- | --- |
| worker 图层投影：确定性 patch、来源 manifest、secret scan、`rev` | 完成 | `lib/cloud-dsh.js`、`test/cloud-profile.mjs`（8/8） |
| 推送与回读校验：备份一次 → 上传 → `sha256sum` + `--dump-config` 校验 | 完成 | `rayrun_dsh sync` / `status` |
| 云端 agent 在新图层下真正可用 | 完成 | 实测 `cloud-yl0w`：remote rev == local rev；agent 回报 `dsh 0.2.0-rc.2`、`pwd=/workspace`、`id -u=0` |
| P1：本插件文件投到 `<profile>/node_modules`，加入 profile `bundles` | 完成 | 实测：插件 `rev` 一致、`bundles` 含 `dsh-rayrun-computer`、`cloudMode` 行生效 |
| P1：`cloudMode: true`（云上不注册云电脑工具，避免递归） | 完成 | 实测：云端 agent 引用了 worker 上下文，且 `rayrun_*` 工具为 none |
| P2：workspace push（git bundle + dirty patch + untracked，双向哈希校验） | 完成 | 实测 `dsh-workspace`：HEAD `25460c4e` 一致、dirty digest `5407ec15…` 一致、8 个 untracked |
| P2：workspace pull（只回传、不自动应用） | 完成 | 实测：云端 +41 B 改动进入 `.dsh/incoming/<ts>/dirty.patch`，本地文件未变 |
| P2：单 writer 锁 + 冲突策略（锁拒绝、`state.json` 偏离拒绝、force 逃生口） | 完成 | 实测：云端改动后 push 被 `workspace_drift` 拒绝；force 覆盖后稳态为 `already-mirrored`；`test/workspace-lock.mjs` 6/6 |
| P3：Context Pack（handoff / conversation / workspace.patch / manifest / profile.json） | 完成 | `lib/context-pack.js`、`test/context-pack.mjs`（8/8，含 secret scan） |
| P3：`rayrun_dsh delegate`（push → 校验/重推投影 → 交付 pack → SSE 聚合 → 结果回传） | 完成 | 实测 `task-mvxscyjy`：worker 回显三元组一致、产物 `.dsh/results/<taskId>/hello.txt` 取回 |
| P3：版本三元组 + 必填清单（缺 objective/acceptance 拒绝委托） | 完成 | Host 实测 `sessionSeq=2532`；三值全匹配才算回显；`workspaceRev` 覆盖 HEAD + dirty + 未跟踪摘要 |
| P4：安全审计（负向测试：跨源、超大 body、未知 action、只读响应无 token） | 完成 | `test/security.mjs` 7/7；测试注入不存在的 `token_file`，避免本机 token 污染断言 |
| P4：成本提示（委托回执带 `vm-h`，按 `usage.vm_hours` 前后差值） | 完成 | `lib/delegate.js` 返回 `vmHours` |
| P4：回退演练（删 profile → 模板重建 → stale → sync 恢复） | 完成 | 实测：layer 0 / plugin none → `sync` → layer 1、bundle added、cloudMode applied |
| P4：自动 stop（可选 `idle_stop_minutes`，默认关；只 stop；有未 pull 改动跳过） | 完成 | 默认关闭；定时器随 Host 重启失效；README 有配置与行为说明 |
| P4：多轮 delta（方案 B 窄版：同 `task_id` 追加、每轮重推并重算 revs、提问经 `questions.md` 带入下一轮） | 完成 | 实测 `task-mvxsuu1v`：round 1 产出 `questions.md` → round 2 的 handoff 带上该问题并产出 `decision.txt`，`task.json` rounds=2 |
| P4：云上 DSH Web 调试入口 | 已评估（不常驻） | 端口发布 API 不存在、`dsh web` 只能绑 loopback、6080 为 public ingress；给出「6080 让给 web + 临时转发」的 runbook，实测 303→200 HTML shell |
| P4：ACP / PTY 实时交互 | 评估后不做 | exec 非交互、无持久 stdin/pty；多轮已由 `task_id` + `questions.md` 覆盖 |

因 §10 的实测结论，MVP 的第 2 步（“云上 bootstrap + 启动 worker”）不再需要：云端 agent 已经是 DSH，本地只投影它的 profile 图层。

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

## 10. Phase 0 结果（2026-11-01，托管集群，探针机器 `cloud-yl0w`）

之前记录的 `ip tuntap` 失败属于本地开发集群；托管集群上创建与运行都正常。探针机器：`deepseek-harness@1`，2 vCPU / 4096 MB / 32 GB workspace。

| 项 | 云上实测 | 本地 | 结论 |
| --- | --- | --- | --- |
| DSH | `0.2.0-rc.2`（`/usr/local/bin/dsh` → `@deepseek-ai/dsh` 全局安装，全部 bundle 齐备） | `0.2.1-rc.5` | 出厂镜像偏低；按白名单重建后可装成同一版本（见下节） |
| Node | v24.22.0 | v24.21.0 | 大版本一致 |
| agent 进程 | guest 进程表里看不到；每次 prompt 由平台在 guest 内起 `dsh --profile headless` | — | **平台 agent 就是 DSH** |
| DSH_HOME | `/workspace/.rayrun/dsh`（在持久化 workspace 上，session 落盘于此） | `~/.dsh` | 云上 home 可写，可投影 |
| profile | `$DSH_HOME/profiles/headless`，首次运行由模板生成；`initProfile` 只补缺失文件，**已有 profile 不被覆盖** | — | 这就是本地投影的写入点 |
| agent shell | 默认 `workspace-write` → `no sandbox backend is usable`（镜像无 bwrap / Landlock / userns），bash 全部失败 | — | 必须在 profile 里覆盖权限模式 |
| egress | 该镜像只放行 `api.deepseek.com`；npm / apt / GitHub 均不可达 | — | 无法在云上装包或钉版本 |
| ingress | 桌面端口有 `https://6080-<id>.rayrunos.com` | — | 核心链路仍不需要 ingress |
| 模型凭证 | 平台只把凭证注入 agent 进程；`exec` 环境里没有 key，`/credentials` 只回 `secret_mask` | — | 无法读回或转交凭证 |

两条结论，取代原先“探针失败、命令待确认”的记录：

1. **云端 worker 就是平台 agent 本身**。不需要另起 worker 进程、不需要 ingress、也不需要把本地密钥送到云上：agent 继承平台注入的模型凭证。
2. **本地 profile 投影能改变云端能力**。在 `$DSH_HOME/profiles/headless/cordis.patch.yml` 覆盖 `sandbox-policy.mode: danger-full-access` 和 `approval.policy: never` 后，云端 shell 立刻可用（实测 `dsh --version`、`pwd`、`id -u` 均正常返回）。
3. **插件上云不需要 tarball 或 npm 安装**。`resolveBundleDir` 用普通 Node 解析（`createRequire(profileDir).resolve.paths`），把插件文件放到 `<profile>/node_modules/<包名>/` 再把包名加进 profile 的 `bundles` 即可；egress 关闭的镜像照样能投影。

### 尚未验证 / 已知风险

- **版本漂移**：`0.2.0-rc.2` 与 `0.2.1-rc.5` 的 patch 方言差异没做全量比对；目前只用到两边都存在的 `id` 覆盖语法。版本本身可以用下面的白名单方式对齐（见下一节）。
- **沙箱绕过 vs 修好**：`workspace-write` 在云上仍然不可用，只是被 profile 覆盖掉了；镜像补上 bubblewrap 才是根治（已实测可装，见下一节）。**决定（2026-11-01）：这台机器归用户使用，worker 暂保持 `danger-full-access`，不切回 `workspace-write`。**
- **平台重建 profile**：如果 Rayrun 之后改成每次重建 `$DSH_HOME/profiles/headless`，投影会被冲掉，需要重新 sync；这一点不由本插件控制。
- 首次 sync 会在机器上留一份 `<profile>.pre-projection` 备份；新机器上它是出厂模板，可原样回滚。

### 访问白名单与版本对齐（2026-11-01 实测）

| 事实 | 结论 |
| --- | --- |
| egress 只能在**创建时**设置 | `PATCH /sandboxes/{id}`、`PUT/PATCH /sandboxes/{id}/egress`、`POST .../network`、`PUT .../spec` 全部 404；要改白名单只能带 `egress.allow` 重建机器 |
| npm 镜像 | 元数据走 `registry.npmmirror.com`，**tarball 在 `cdn.npmmirror.com`**，两个域名必须一起放行；`registry.npmjs.org` 的 tarball 实测 ~8 KB/s，不可用 |
| 版本对齐 | `npm i -g @deepseek-ai/dsh@0.2.1-rc.5` 后云上 `dsh --version` == 本地的 `0.2.1-rc.5`；Node 云上 v24.22.0 / 本地 v24.21.0（同大版本） |
| 沙箱后端 | `apt-get install -y bubblewrap` 得到 0.9.0，`bwrap --ro-bind / / ... true` 实测可运行；镜像缺的正是它，补上后 `workspace-write` 具备可用前提 |
| 验收 | 云上 agent 实测回报 `0.2.1-rc.5`、`pwd=/workspace`、`id -u=0`、`bubblewrap 0.9.0`、profile 目录含投影文件，且 `rayrun*` 工具为 none |

推荐的最小 egress 白名单（对齐本地能力所需）：

```text
api.deepseek.com        # 模型调用
registry.npmmirror.com  # npm 元数据
cdn.npmmirror.com       # npm tarball
mirrors.aliyun.com      # apt 镜像（可选，取决于 sources.list）
archive.ubuntu.com      # apt
security.ubuntu.com     # apt 安全更新
```

worker 目前仍用 `danger-full-access`：云上没有人可以回答「是否允许」的审批，`workspace-write` 一旦碰到 cwd 之外的写就会卡在审批上。要切回 `workspace-write` 需要先在平台侧提供审批通道或预授权策略。

guest exec 兼容性：较新的 guest agent 会把 `$(...)` 命令替换吞掉并截断其后的所有命令（同一脚本里 `echo "x: $(id -u)"` 会打印空值且后续不执行）。插件里的 exec 命令已改为不依赖命令替换。

---

## 11. 验收清单

- [x] 云上/本地 DSH 版本一致（实测 `cloud-yl0w` 出厂 `0.2.0-rc.2`；按白名单重建后 `dsh-workspace` 为 `0.2.1-rc.5` == 本地，Node v24 一致）
- [x] 云上 profile 的 bundle 清单包含本插件，且插件文件与本地 `rev` 一致
- [x] 云上本插件 `cloudMode: true`：无云电脑工具、无「云上/本地」切换上下文
- [ ] 云上 profile 是本地投影：presets、skills、MCP、模型路由一致（当前只投影 worker 图层与本插件）
- [x] worker 图层由本地投影推送，`rev` 可校验（`rayrun_dsh status` 比对远端 `sha256`）
- [x] 投影通过 secret scan；不读取、不产出本地凭证
- [ ] 云上 profile 只读；profileRev 漂移会被发现/拒绝
- [x] workspace push 后 HEAD + dirty patch hash 一致（实测 `dsh-workspace`：`25460c4e` / `5407ec15…` 双端一致）
- [x] 每次委托生成 Context Pack：handoff / conversation / patch / manifest / profileRev（写到 `.dsh/handoff/<taskId>/` 并上传云端）
- [x] Context Pack 通过 secret scan；无本地凭证、`.env`、SSH key（作者文本扫描命中即拒绝；workspace.patch 与已推送工作区同源）
- [x] worker 首响应回显 sessionSeq / workspaceRev / profileRev，且与本地匹配（实测 `task-mvxscyjy`：三值一致，`echoed: true`）
- [ ] worker 丢失后可从本地 session log + workspace + 最近结果重建
- [x] 云上任务通过 prompt/SSE 委托，本地 session log 记录完整（委托结果是本地 tool result；pack/结果落在 `.dsh/`）
- [x] 云上 diff 回传本地，本地 review/merge 后才成为权威（`pull` 只写 `.dsh/incoming`，不自动应用）
- [x] 单 writer 锁：云上任务运行期间 `push` 被拒绝；云端偏离上次 push 时被 `workspace_drift` 拒绝；`force` 是唯一逃生口
- [ ] 云上 profile `cloudMode: true`，无递归云电脑切换/创建
- [ ] 本地模式完全本地；云上不可用明确失败，不静默降级
- [ ] 无本地密钥进入云上；ingress（如启用）仅 token
- [x] 空闲自动 stop（可选 `idle_stop_minutes`，默认关；只 stop 不 destroy；有未 pull 改动则跳过）；destroy 前提示产物回传仍未做

---

## 12. 仍需确认

已由 Phase 0 回答：

1. ~~**委托传输**~~ → 就是 Rayrun 的 agent prompt + SSE（`rayrun_agent`）：平台 agent 本身是 DSH（`dsh --profile headless`），事件流可用，不需要 ACP/PTY，也不需要 ingress。
2. ~~**集群前提**~~ → 托管集群可用；`ip tuntap` 只出现在本地开发集群。云上 agent 已确认由 DSH 接管。

仍待你决定：

1. **交互粒度**：首版只做“整段任务委托”，还是需要多轮追问 / 流式交互？（现在 `rayrun_agent` 是整段任务 + 事件摘要。）
2. **云上 profile 的边界**：`cloudMode` 在 headless 里没有客户端面板可隐藏，所以问题变成——云上 profile 要不要带本插件（`dsh-rayrun-computer`）？带了要禁掉哪些 host 能力才算不递归。
3. **版本策略**：云上 `0.2.0-rc.2` 装不了包，短期只能“声明兼容区间 + 启动前比对版本”，还是推动镜像升级到与本地同版本？

下一步按 P1 剩余项推进：本地插件 tarball 上云 + 版本比对；然后 P2 workspace push/pull；P3 再做 Context Pack 与版本三元组。
