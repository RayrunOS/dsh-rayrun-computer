# dsh-rayrun-computer

Rayrun 云电脑 — DeepSeek Harness 插件

把 [Rayrun](https://rayrunos.com/) 的云端沙箱做成 DSH 里的「云电脑」：左侧边栏有独立入口，可以创建、开关机、查看规格，并在页面里直接打开 Rayrun 的 noVNC 远程桌面。同一批机器也继续暴露为 `rayrun_*` 工具，供模型执行命令、搬运文件和跑整段 agent 任务。

> 云上 DSH 与本地 DSH 的一致性方案（本地权威）见 [docs/cloud-dsh-parity-plan.md](docs/cloud-dsh-parity-plan.md)。

## 这次重新设计做了什么

| 之前 | 现在 |
| --- | --- |
| 只有「设置 → Rayrun 沙箱云」里的一个 Token 输入框 | 侧边栏 **云电脑** 一级入口 + 完整的机器列表、创建向导、连接设置 |
| 只能通过模型工具间接使用沙箱 | 可以直接在浏览器里打开 Rayrun 远程桌面（noVNC） |
| 看不到机器状态、费用、规格 | 卡片展示运行状态、镜像、CPU/内存、IP、机时；顶部显示余额与累计机时 |
| 创建参数只能改 `cordis.patch.yml` | 页面内选镜像和规格，创建后自动打开桌面 |
| 工具与页面各写一套 API 逻辑 | 共用 `lib/rayrun.js`，Token/API 地址只有一处解析 |
| 任务只能在本地电脑上跑 | 输入区「工作任务」可切换 **云上电脑 / 本地电脑**，按会话注入运行位置 |

## 功能

- **云电脑列表**：只显示未销毁的机器，运行中 → 暂停 → 关机排序。
- **创建**：选支持桌面的镜像、vCPU、内存（远程桌面最少 2 GB），自动生成名称。平台冷启动失败（`vsock` 连不上 guest agent）时机器会被销毁且不计费，插件自动重试一次；仍失败会提示「稍后重试」。
- **生命周期**：开机、恢复、关机（冷停）、重命名、销毁（带确认）。
- **远程桌面**：机器开启 `remote_desktop` 后，Rayrun 会自动发布镜像的 `desktop_port`（通常是 6080）。插件读取 `sandbox.ingress[].url`，用 iframe 打开，并提供新窗口、全屏、重载。
- **桌面密码**：在机器里执行 `rayrun-desktop status`，把输出（含 VNC 密码）显示在弹窗里，可复制。
- **账户信息**：余额、累计机时、运行中数量。
- **连接设置**：支持用户名/邮箱 + 密码登录、微信登录；登录成功后自动创建 API Token 并存入 Harness 凭证库，也保留手动粘贴 Token 的方式。
- **模型工具**：`rayrun_sandbox` / `rayrun_exec` / `rayrun_files` / `rayrun_agent`，并新增 `remote_desktop` 创建参数。
- **输入区切换**：在 composer 左侧选择「工作任务 · 云上电脑 / 本地电脑」，按会话决定任务在哪台机器上执行。
- **更新检查**：启动时和每 6 小时查一次 npm 上的新版本；有更新时云电脑页顶部给出「立即更新」。

## 输入区：工作任务运行位置

对话输入区左下角有一个「工作任务」切换：

| 选项 | 行为 |
| --- | --- |
| 云上电脑 | Host 给当前会话注入一条运行位置上下文：实际执行、代码修改、构建和产物都放在 Rayrun 云电脑（默认机器名 `dsh-workspace`，不存在时由 `rayrun_sandbox` 创建）；本地只读取必要输入、查看和汇总。 |
| 本地电脑 | 保持默认行为：按常规使用本地工具，除非用户明确要求不调用 `rayrun_*`。 |

- 选择按 **会话** 隔离，页面把选择存在 `localStorage`，Host 侧保存运行时映射；刷新/重新打开页面后控件会把选择同步回 Host。
- 这是 **指令级路由**，不是硬隔离：两种模式下工具都仍然存在，模型按上下文选择机器；这样本地读取、上传、汇总不会被误伤。
- 「云上电脑」用 `sandboxName` 的默认机器；如果要多台机器，在「云电脑」页创建/管理，再在对话里点名机器名。
- 未配置 Rayrun Token 时切到云上电脑，模型会明确报告工具不可用，不会假装已在云端完成。

## 安装

这是一个 DSH bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。

```text
plugin_manager install_bundle  target = <这个包的绝对目录>
```

安装后如果页面还是旧版，重新打开 `dsh web` 打印的**带认证 token 的 URL**（裸 `http://127.0.0.1:<port>` 会返回 401），或重启 DSH。Client 半区只在页面启动时加载；替换/改名已安装的包后，DSH 进程会缓存旧的 client 包路径，重启是最可靠的刷新方式。

> 仓库与包名已统一为 `dsh-rayrun-computer`，与 GitHub 仓库 `RayrunOS/dsh-rayrun-computer` 一致。如果当前页面仍显示旧版，重新打开认证 URL 即可。

### 更新

插件启动时查一次 npm registry（`registry.npmjs.org`，失败时回退 `registry.npmmirror.com`），之后每 6 小时一次；同一进程内 5 分钟内不重复请求。检查只发送包名。

- 有更新时，**云电脑**页顶部显示「发现新版本 v{version}（当前 v{current}）」和「立即更新」。
- 点击后 Host 通过 profile 的插件管理器卸载旧版本、安装新版本（精确版本），完成后提示重启 DSH 或刷新页面。
- 只对 registry 安装生效（依赖是 `dsh-rayrun-computer@x.y.z`）。`link:` / `file:` / tgz / `git+` 安装不显示按钮，更新按原来的安装方式重装。
- 安装失败（例如新版本要求更高的 DSH）会尝试装回旧版本，回滚结果写在提示里。
- 包没有发布到 npm 时，检查得到 404 并静默忽略，页面不显示提示。
- 移除自身会让这次请求的响应可能丢失；这种情况页面提示「更新已发起，请重启 DSH 确认」。

## 连接 Rayrun

首次打开「云电脑」会要求连接：

- **Rayrun 官网**：`http://rayrunos.com/`。
- **API 地址**：页面不再显示，默认 `https://api.rayrunos.com/v1`（托管环境；`rayrunos.com/v1` 是官网 SPA，不是 API）。自托管 / 本地开发用环境变量 `RAYRUN_API_URL=http://<dev-host>/v1`，或写进 `~/.rayrun/dsh.json` 的 `baseUrl`。
- **API Token**：Rayrun 控制台「设置 → 我的 API Token」创建，明文只显示一次。

插件按以下顺序解析，命中即停：

| 顺序 | Token 来源 | 说明 |
| --- | --- | --- |
| 1 | 插件 config 的 `token` | 临时调试；会明文留在 profile 配置里 |
| 2 | Harness 凭证库的 `RAYRUN_TOKEN` | 页面「连接设置」写入的位置，推荐 |
| 3 | 环境变量 `RAYRUN_TOKEN` | CI / 脚本启动 |
| 4 | `~/.rayrun/token` | 与 Rayrun CLI 共用，零配置 |

API 地址的优先级：页面保存的地址（`~/.rayrun/dsh.json`）→ 插件 config 的 `baseUrl` → 环境变量 `RAYRUN_API_URL` → `https://api.rayrunos.com/v1`。

### 登录方式

「云电脑 → 连接设置」有两种登录方式，登录成功后都会**自动创建一个 API Token** 并写入 Harness 凭证库，不需要再去控制台手动复制：

| 方式 | 流程 |
| --- | --- |
| 用户名 / 邮箱 + 密码 | Host 调 `POST /auth/login`，拿到 `rayrun_session` 后立即调 `POST /tokens` 创建 Token；密码只存在内存，不落盘、不写日志 |
| 微信登录 | Host 用本机 Chrome/Edge 打开 Rayrun 登录页（独立临时 profile，只读 `rayrun_session`），用户扫码后 Host 通过 CDP 读取会话 Cookie，再调 `/_api/v1/tokens` 创建 Token |

- 微信登录窗口是**可见的浏览器窗口**，不是静默自动化；登录完成后窗口会自动关闭，临时 profile 会清理。
- 没有可用的 Chrome/Edge 时，微信按钮会退化为打开 Rayrun 登录页，并要求回到插件手动粘贴 Token；可用 `RAYRUN_CHROME_PATH` 或 `CHROME_PATH` 指定浏览器。
- 自动创建的 Token 名称形如 `DeepSeek Harness (<hostname>)`；`断开连接` 会尝试吊销这个 Token 并清除本地凭据。
- 连接成功后，「连接设置」里直接显示账户名、角色、余额和累计机时；「更换账号」才会重新展开登录表单。
- Token 只保存在 Host 侧；页面通过 `/plugins/rayrun/rpc` 调用，接口不返回 Token 明文。
- 仍然保留「API Token」页签，用于粘贴已有 Token 或 CI 场景。

### 云上模型凭证（可选）

云电脑里的 agent（例如 `deepseek-harness@1`）要调模型，需要 Rayrun 在创建机器时把厂商 key 注入进去。这个选择在**「新建云电脑」对话框**里：

| 选项 | 行为 |
| --- | --- |
| 已有凭证（下拉列出） | 直接带 `credentials: [名字]` 创建，凭证内容由 Rayrun 持有 |
| 新建模型凭证… | 填一次 key，插件调 `POST /v1/credentials` 建一份 `dsh-model-<hostname>`，这次和以后都能选 |
| 不注入 | 不建也不带凭证；机器里的 agent 没有模型 key |

- 下拉来自 `GET /v1/credentials`，只显示名字/厂商/槽位，永远拿不到密文。
- key 只在这一次请求里用来写凭证，不落盘、不进日志。
- 凭证只在**创建**机器时注入，已经存在的机器要重建才会带上。
- 轮换 key：在「新建模型凭证…」里再提交一次即可（同名 upsert）。

## 云电脑与远程桌面

Rayrun 的 agent 镜像元数据里有 `supports_desktop` 和 `desktop_port`。创建时传 `remote_desktop: true`：

```json
{
  "name": "design-box",
  "agent": "ubuntu@1",
  "cpu_cores": 2,
  "memory_mb": 2048,
  "remote_desktop": true
}
```

平台会自动把桌面端口发布成入向 URL（`sandbox.ingress[]`），插件用它打开桌面。注意：

- 远程桌面要求 **至少 2048 MB 内存**，低于该值 API 会拒绝。
- 部署必须启用入向访问（返回 `ingress[].url`）。没有返回 URL 时，页面会说明原因，机器仍可通过工具执行命令。
- 桌面是 HTTP 的 noVNC；生产环境的对外 URL 由 Rayrun 的入向网关提供，通常是 HTTPS。
- 部分 `deepseek-harness@1` 镜像的 `/etc/hosts` 为空，`websockify` 解析 `localhost:5900` 失败，表现为 noVNC 页面能打开但 WebSocket 被 1011 关闭。插件在连接/重载桌面时会自动补 `127.0.0.1 localhost` / `::1 localhost`，并确保 `rayrun-desktop` 在运行。
- 如果 iframe 被桌面服务的安全头挡住，用工具栏的「新窗口打开」。

## 云上 DSH worker 图层

Rayrun 的机器 agent 本身就是一个 DSH：每次任务由平台在机器内起 `dsh --profile headless`，`DSH_HOME` 落在持久化 workspace（`/workspace/.rayrun/dsh`）。所以云上 agent 的能力由 `$DSH_HOME/profiles/headless` 决定，而本地可以往那里推一层。

`rayrun_dsh` 做两件事：

- `sync`：把本地 profile 的 worker 图层推进机器的 `$DSH_HOME/profiles/headless/`，写完回读 `sha256` 和 `--dump-config` 结果做校验；首次同步前把原 profile 备份成 `headless.pre-projection`。
- `status`：只读比对——本地 `rev` 与云端 `rev` 是否一致、图层是否真的生效、云端 `dsh` / `node` 版本。

图层只有一个确定性文件（`cordis.patch.yml`）加一份来源清单（`cloud-projection.json`）：

```yaml
- id: sandbox-policy   # mode: danger-full-access
- id: approval         # policy: never
- id: rayrun-cloud     # 本插件；cloudMode: true
```

同时把本插件自己的文件投到 `<profile>/node_modules/dsh-rayrun-computer/`，并把包名加进 profile 的 `bundles`。DSH 解析 profile bundle 走的是普通 Node 解析，所以**不需要打包 tarball，也不需要云上有网络或装包**——这对 egress 只放行模型域名的镜像很关键。

云上的本插件以 `cloudMode: true` 运行：不注册任何云电脑工具、不注入「云上/本地」切换上下文，只留一句「本机是 Rayrun 云上 worker」的上下文。这样云端 agent 不会递归去管别的机器。

为什么必须要这一层：`deepseek-harness@1` 镜像里没有 bubblewrap，也没有可用的 Landlock / userns，DSH 默认的 `workspace-write` 沙箱后端起不来，云端 agent 的 bash 会在执行前直接报 `no sandbox backend is usable on this host`。覆盖成 `danger-full-access` 后 shell 才可用。

边界：

- 云上机器本来就是 guest 里的 root，这一层不提供额外隔离；镜像补上 bwrap 才是根治。
- 不要在云上手改这个文件，`sync` 会覆盖它；要改改本地再同步。
- 云上 profile 是 headless 的，只投 host 半区文件（不含 `client.js`），不要用它去跑 `dsh web`。
- 投影只带 worker 图层与插件，不带本地 skills / MCP / 其他插件；见 `docs/cloud-dsh-parity-plan.md`。
- 出厂镜像是 DSH `0.2.0-rc.2`；想和本地同版本，按下面的白名单方式建机器后自己升。

### 让云上和本地一致（白名单 → 版本 → 沙箱后端）

白名单**只能在创建机器时给**：托管 API 没有改 egress 的路由（`PATCH /sandboxes/{id}`、`PUT .../egress`、`POST .../network` 全部 404）。要放宽就先建一台带 `egress.allow` 的机器：

```yaml
# cordis.patch.yml（可选：让本插件自动创建的机器自带这份白名单）
- id: rayrun-cloud
  name: 'dsh-rayrun-computer'
  config:
    egress_allow:
      - api.deepseek.com        # 模型调用
      - registry.npmmirror.com  # npm 元数据
      - cdn.npmmirror.com       # npm tarball（npmmirror 的 tarball 走这个域名）
      - mirrors.aliyun.com
      - archive.ubuntu.com
      - security.ubuntu.com
```

机器建好后：

```bash
npm config set registry https://registry.npmmirror.com --location=global
npm install -g @deepseek-ai/dsh@<本地 dsh --version>   # 版本对齐
apt-get update -qq && apt-get install -y bubblewrap    # 补上镜像缺的沙箱后端（可选）
dsh --version && bwrap --version
```

2026-11-01 实测：`dsh-workspace` 上 `dsh --version` 为 `0.2.1-rc.5`（与本地一致）、`bubblewrap 0.9.0` 可运行、worker 投影与插件均生效，且云端 agent 没有 `rayrun*` 工具。`registry.npmjs.org` 的 tarball 实测约 8 KB/s，不要用。

## 工作区同步（本地权威）

`rayrun_workspace` 把本地 checkout 与云电脑的 workspace 对齐：

- `push`：先用 `git bundle create --all` 把提交带过去（commit 号不变），再上传 `git diff --binary HEAD` 的脏改动和未跟踪文件，最后**在云上重新生成同一份 patch 并比对 SHA-256**，另外校验 `HEAD`。任一项不一致就报错，不假装成功。
- `pull`：把云上的 `git diff --binary HEAD` 与 `git status` 抓到本地 `.dsh/incoming/<时间戳>/`，**不自动应用**；审阅后自己 `git apply`（或丢弃）。

细节：

- **单 writer 锁**：`rayrun_agent` / `rayrun_exec` 运行期间持有该机器的 workspace 锁，此时 `push` 会被拒绝（`workspace_locked`）。锁是进程内状态，Host 重启即失效（和「云上/本地」切换一致）。
- **冲突策略**：每次 `push` 会在云端 `.dsh/state.json` 记录 `head` + dirty 摘要；下次 `push` 若发现云端已偏离（agent 改动、或 pull 过但没合并），直接拒绝（`workspace_drift`）并提示先 `pull`。
- **`force: true`** 是逃生口：越过锁与偏离判定，覆盖云端树。会删掉未 pull 的云端改动，只在明确要丢弃时用。升级后第一次 push 因为云端树来源未知，需要 `force`。
- 云上的 `git clean` 只清工作区文件，会排除 `.rayrun/`（DSH home）、`.dsh/`（同步产物）和 `lost+found/`。
- 上限：脏 patch 16 MB、未跟踪 200 个文件 / 32 MB、bundle 64 MB；带 shell 元字符的路径直接拒绝。
- 未跟踪文件不走 diff：推送后逐个比对 sha256，摘要也会并入 `workspaceRev`（未跟踪内容变了，rev 一定变）。
- `.dsh/` 已在 `.gitignore` 里，pull 下来的 patch 不会被误提交。
- 本地没有 commit、或目录不是 git 仓库时，`push` 会明确失败而不是传一个空快照。

## 委托任务到云上 worker

`rayrun_dsh` 的 `delegate` 动作把整段任务交给云电脑里的 DSH worker，本地仍是权威：

1. 先 `push` workspace 并校验 HEAD + dirty 摘要（不通过直接失败）；
2. 校验云端 profile 是否仍是本地投影，漂移则重推；
3. 生成本地 `.dsh/handoff/<taskId>/round-<n>/` 并上传云端（`task.json` 记任务轮次）：

   ```text
   handoff.md        目标 / 约束 / 已决策 / 未决问题 / 验收标准 / 版本三元组
   conversation.md   本地上下文摘录（可选，来自 context 参数）
   workspace.patch   本次推送的 dirty 改动
   manifest.json     round + revs + workspace 状态 + 每个文件的 sha256
   profile.json      来源 profile、图层/插件 rev、插件版本
   ```

4. 取 workspace 锁（期间本地 `push` 被拒绝），发 prompt、聚合 SSE；
5. 要求 worker 首行回显 `REVS sessionSeq=… workspaceRev=… profileRev=…`，三值全中才记 `echoed: matched`；
6. 把 worker 写到 `.dsh/results/<taskId>/` 的产物取回本地同名目录。

**多轮**：带 `task_id` 再委托一轮即可继续同一个任务——轮次从 `task.json` 递增、每轮重新 push 并重算 revs、上一轮 worker 写在 `.dsh/results/<taskId>/questions.md` 的提问会自动带进新 handoff。worker 遇到需要本地决定的事就写 `questions.md` 并结束本轮，回执会提示用 `task_id=` 追加。

必填 `objective` 与 `acceptance`（每一轮都要），缺任何一项直接拒绝；`handoff.md` / `conversation.md` 命中 secret 规则也会拒绝（`workspace.patch` 与已推送工作区同源，不重复拦截）。

委托回执里会带 `vm-h`（本次任务消耗的机器机时，按 `usage.vm_hours` 前后差值算）与可选的 `auto-stop in N min`。

## 自动停机（可选，默认关闭）

```yaml
- id: rayrun-cloud
  name: 'dsh-rayrun-computer'
  config:
    idle_stop_minutes: 15   # 默认 0 = 从不自动停
```

开启后，`rayrun_exec` / `rayrun_agent` / `delegate` 成功结束后会排一个定时器：

- 到点时若该机器仍有任务持有 workspace 锁，则跳过；
- 若云端 workspace 有**未 pull 的改动**（HEAD 或 dirty 摘要与上次 push 不一致），也跳过并保持运行；
- 只执行 `stop`，**永不自动 destroy**；新任务会取消未到点的定时器。

定时器在 Host 内存里，重启即失效（与任务目标、workspace 锁一致）。

## 回退演练（实测）

云上 worker 的 profile 是可丢弃的：删掉它，DSH 会按模板重建，`status` 会立刻报 stale，再 `sync` 一次就恢复。2026-11-01 在 `dsh-workspace` 上做过完整演练：

```text
status → synced（layer 8d8401f5，插件在 bundles）
rm -rf $DSH_HOME/profiles/headless && dsh --profile headless --dump-config
  → layer 0 / 插件不在 bundles / 无 manifest
status → stale（remote ef189a8c，plugin none，cloudMode not applied）
sync   → synced（layer 恢复、bundle added、cloudMode applied）
```

首次 sync 会在机器上留一份 `<profile>.pre-projection`，也可以直接 `cp -a` 回滚到那一次的投影。

## 配置项（`cordis.patch.yml`）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | 代码内 `https://api.rayrunos.com/v1` | 部署地址；页面保存的地址优先 |
| `sandboxName` | `dsh-workspace` | 工具缺省机器名，不存在时按 `autoCreate` 创建 |
| `agent` / `default_agent` | `deepseek-harness@1` | 新建机器的默认镜像，也是「新建云电脑」的默认选中项 |
| `cpu_cores` / `memory_mb` | `2` / `2048` | 新建规格 |
| `workspace_mb` | 镜像默认 | 工作区磁盘 |
| `egress_allow` | `[]` | 出向白名单；平台默认完全断网 |
| `credentials` | `[]` | 注入机器的 Rayrun 凭证名 |
| `remote_desktop` | `false` | 工具自动创建机器时是否开启桌面 |
| `autoCreate` | `true` | 机器不存在时是否自动创建 |
| `default_timeout_seconds` | `300` | `rayrun_exec` 缺省超时 |
| `idle_stop_minutes` | `0`（关闭） | 任务结束后空闲多久自动 `stop`；有未 pull 改动时跳过 |
| `token` / `token_file` | 无 | 见上一节 |

当前 bundle 的 patch 指向托管 API `https://api.rayrunos.com/v1`，官网是 `http://rayrunos.com/`。切到托管环境后，本地开发集群的 token 会返回 401，需要在「云电脑 → 连接设置」里重新粘贴托管环境的 API Token；也可以用 `RAYRUN_API_URL` 或页面保存的地址覆盖。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rayrun_sandbox` | create / list / inspect / start / stop / pause / resume / destroy |
| `rayrun_exec` | 执行非交互命令，返回 exit code、stdout、stderr |
| `rayrun_files` | 工作区 list / upload / download |
| `rayrun_agent` | 把整段任务交给机器内 agent，流式等待结果 |
| `rayrun_dsh` | 云上 DSH worker：`sync` 推送并校验图层，`status` 只读比对，`delegate` 委托整段任务 |
| `rayrun_workspace` | 工作区同步：`push` 推送并校验 HEAD/摘要，`pull` 回传 diff 供本地审阅 |

## 安全与边界

- Token 只存在 Host 侧。页面通过 `/plugins/rayrun/rpc` 调用，接口不返回 Token，只返回来源与是否配置。
- RPC 只接受同源 POST（校验 `Origin`），并限制请求体大小。
- Token 文件、`~/.rayrun/dsh.json` 均为用户本机文件；发布包不包含任何 Token。
- 销毁不可恢复：机器和工作区数据一起删除。
- 新建机器默认无出向网络；装包或调用外部 API 需显式配置 `egress_allow`。
- `rayrun_exec` 的 `command` 走 `/bin/sh -c`，`argv` 直接 exec，二者只能给一个。

## 开发自测

```bash
node --check index.js
node --check lib/rayrun.js
node --check lib/cloud-dsh.js
node --check lib/cloud-workspace.js
node --check lib/workspace-lock.js
node --check lib/context-pack.js
node --check lib/delegate.js
node --check lib/sse.js
node --check lib/update.js
node --check client.js
node test/locale-audit.mjs
node test/cloud-profile.mjs
node test/cloud-workspace.mjs
node test/workspace-lock.mjs
node test/context-pack.mjs
node test/cloud-tool.mjs
node test/security.mjs
node test/update-unit.mjs
node test/update-rpc.mjs
node test/update-rpc.mjs missing
node test/api-smoke.mjs <sandbox-id>
```

`test/api-smoke.mjs` 只用于联调，不在 `files` 里，不会进包。默认连托管 API；本地开发集群用 `RAYRUN_API_URL=http://<dev-host>/v1` 覆盖。

`test/update-rpc.mjs` 用假的 Harness 上下文和插件管理器驱动 `index.js` 里真实的 `/plugins/rayrun` handler，覆盖检查、应用、link 安装拒绝、失败回滚；`missing` 场景模拟 registry 上没有这个包。

`test/cloud-profile.mjs` 只测投影的纯逻辑（确定性 `rev`、manifest 来源、secret scan、图层覆盖项），不打 Rayrun API。`rayrun_dsh` 的推送与回读校验需要真实机器，联调时用 `rayrun_dsh sync` / `status` 对着探针机器跑一次。`test/cloud-tool.mjs` 用假上下文驱动真实的 `apply`，断言 `rayrun_dsh` 的注册形状与非法 action 的拒绝路径。`test/security.mjs` 是负向测试：跨源 POST、超大请求体、未知 action、非法 target，以及只读响应里不得出现 token。
