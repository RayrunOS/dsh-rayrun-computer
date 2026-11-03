# 使用手册

装好之后怎么用、行为边界在哪。安装与第一次连接见 [安装指南](installation.md)；为什么是「本地权威」、云上 worker 的取舍见 [云上/本地一致性方案](cloud-dsh-parity-plan.md)。

## 目录

- [云电脑页面](#云电脑页面)
- [远程桌面](#远程桌面)
- [输入区：云上还是本地](#输入区云上还是本地)
- [云上 DSH worker 图层](#云上-dsh-worker-图层)
- [工作区同步](#工作区同步本地权威)
- [委托任务到云上 worker](#委托任务到云上-worker)
- [自动停机](#自动停机可选默认关闭)
- [更新检查](#更新检查)
- [回退演练](#回退演练实测)
- [配置项](#配置项)
- [工具](#工具)
- [安全与边界](#安全与边界)

## 云电脑页面

侧边栏 **云电脑**（英文界面为 **Cloud Computer**）是独立入口，不和「设置」里的连接配置混在一起。

- **列表**：只显示未销毁的机器，按 `运行中 → 暂停 → 关机` 排序；卡片上有状态、镜像、规格、IP 和已用机时，页面顶部显示账户余额、累计机时和运行中数量。
- **新建**：在页面里选镜像、vCPU、内存（远程桌面至少 2 GB），名称自动生成，也可以填自己的。创建成功后自动打开桌面。
- **生命周期**：开机、恢复、关机（冷停）、重命名、销毁（二次确认）。销毁不可恢复，机器和工作区数据一起删除。
- **冷启动失败**：平台报 `vsock` 连不上 guest agent 时，机器会被销毁且不计费；插件自动重试一次，仍失败就提示「稍后重试」。

### 云上模型凭证（可选）

云电脑里的 agent（例如 `deepseek-harness@1`）要调模型，需要 Rayrun 在创建机器时把厂商 key 注入进去。这个选择在「新建云电脑」对话框里：

| 选项 | 行为 |
| --- | --- |
| 已有凭证（下拉列出） | 直接带 `credentials: [名字]` 创建，凭证内容由 Rayrun 持有 |
| 新建模型凭证… | 填一次 key，插件调 `POST /v1/credentials` 建一份 `dsh-model-<hostname>`，这次和以后都能选 |
| 不注入 | 不建也不带凭证；机器里的 agent 没有模型 key |

- 下拉来自 `GET /v1/credentials`，只显示名字/厂商/槽位，永远拿不到密文。
- key 只在这一次请求里用来写凭证，不落盘、不进日志。
- 凭证只在**创建**机器时注入，已经存在的机器要重建才会带上。
- 轮换 key：在「新建模型凭证…」里再提交一次即可（同名 upsert）。

## 远程桌面

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

平台会把桌面端口发布成入向 URL（`sandbox.ingress[]`），插件读取后直接用 iframe 打开，并提供新窗口、全屏、重载。

- 远程桌面要求 **至少 2048 MB 内存**，低于该值 API 会拒绝。
- 部署必须启用入向访问（返回 `ingress[].url`）。没有返回 URL 时，页面会说明原因，机器仍可通过工具执行命令。
- 桌面是 HTTP 的 noVNC；生产环境的对外 URL 由 Rayrun 的入向网关提供，通常是 HTTPS。
- **桌面密码**：点卡片上的「桌面密码」会在机器里执行 `rayrun-desktop status`，把输出（含 VNC 密码）显示在弹窗里，可复制；打开桌面时也会尝试自动填入。
- **1011 排障**：部分 `deepseek-harness@1` 镜像的 `/etc/hosts` 为空，`websockify` 解析 `localhost:5900` 失败，表现为 noVNC 页面能打开但 WebSocket 被 1011 关闭。插件在连接/重载桌面时会自动补 `127.0.0.1 localhost` / `::1 localhost`，并确保 `rayrun-desktop` 在运行。
- 如果 iframe 被桌面服务的安全头挡住，用工具栏的「新窗口打开」。
- 机器创建时没开桌面，之后无法补开，只能新建一台。

## 输入区：云上还是本地

对话输入区左下角（英文界面为 **Task runs on**）有一个「工作任务」切换：

| 选项 | 行为 |
| --- | --- |
| 云上电脑 | 当前会话注入运行位置上下文（优先 `rayrun_dsh delegate`），**并硬性禁用本地 `pwsh` / `bash` / `write` / `edit`**：这些调用会被 Host 的 tools guard 直接拒绝，并提示改用 `rayrun_exec` / `rayrun_files` / `rayrun_workspace` / `rayrun_dsh delegate`。 |
| 本地电脑 | 默认行为：本地工具全部可用，除非用户明确要求不调用 `rayrun_*`。 |

- 选择按 **会话** 隔离，页面把选择存在 `localStorage`，Host 侧保存运行时映射；刷新/重新打开页面后控件会把选择同步回 Host。
- 这是 **工具级路由**：云上模式下本地写入/执行被拒绝（不是提示词），模型无法悄悄留在本地干活；`read` / `glob` / `grep` / `read_image` 仍然可用，因为审阅和汇总是本地职责。
- 被拦的只有本地写入/执行；`rayrun_*` 与委托链路不受影响（`delegate` 内部的 push 属于插件代码，不经工具层）。
- 审阅云上回传的 diff 时，`git apply` 属于本地写入 → 需要先切回「本地电脑」，或由你自己在终端应用。
- 「云上电脑」用 `sandboxName` 的默认机器；如果要多台机器，在「云电脑」页创建/管理，再在对话里点名机器名。
- 未配置 Rayrun Token 时切到云上电脑，模型会明确报告工具不可用，不会假装已在云端完成。
- Host 重载会清空内存里的映射，页面重新同步后恢复。

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
- 投影只带 worker 图层与插件，不带本地 skills / MCP / 其他插件；见 [一致性方案](cloud-dsh-parity-plan.md)。
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

### 不等待：start / status / result

`delegate` 会阻塞到 worker 结束（上限 900 s）。要让任务**活过本轮**——合上电脑、关掉页面也照样跑——用三件套：

| 动作 | 作用 |
| --- | --- |
| `start` | 做完 1–4 步（含取锁、发 prompt）后立刻返回 `taskId`，不聚合 SSE。云端 worker 自己跑。 |
| `status` + `task_id` | 只读探针：云端有没有 `dsh --profile headless` 在跑、`.dsh/results/<taskId>/` 有哪些文件、最近改动时间、workspace 锁归谁。不下载任何东西。 |
| `result` + `task_id` | 把产物取回本地；**worker 已经不在跑**时释放 workspace 锁，并按自动停机策略安排关机。 |

语义要点：

- **锁跟着任务走。** `start` 取的 workspace 锁一直持有到 `result` 看到 worker 退出为止，期间 `rayrun_workspace push` 会被拒绝——否则 push 会把 worker 正在改的树覆盖掉。
- **锁在进程内存里。** Host 重启后锁消失，`result` 会提示「锁不在本进程里」，`push` 前先自己确认云端状态。
- **status 的判据是进程，不是文件。** worker 可能先写产物、再继续干活；只有进程没了才算这轮结束。
- **`result` 可以提前调。** 拿到的是阶段性产物，锁不释放，可以再调一次。

## 自动停机（可选，默认关闭）

```yaml
- id: rayrun-cloud
  name: 'dsh-rayrun-computer'
  config:
    idle_stop_minutes: 15   # 默认 0 = 从不自动停
```

开启后，`rayrun_exec` / `rayrun_agent` / `delegate` / `start` 成功结束后会排一个定时器：

- 到点时先问机器**有没有 `dsh --profile headless` 在跑**：有就不停（这条判据在 guest 里，Host 重启、别的会话起的任务都算数）；
- 再看本进程有没有任务持着该机器的 workspace 锁（`delegate` / `start` 的锁一直持有到收取）；
- 若云端 workspace 有**未 pull 的改动**（HEAD 或 dirty 摘要与上次 push 不一致），也跳过并保持运行；
- 探测本身失败（连不上机器、读不到 workspace 状态）时**按不停处理**，失败的探测不算空闲证据；
- 只执行 `stop`，**永不自动 destroy**；新任务会取消未到点的定时器。

被跳过的停机**会重新排期**（同一个 `idle_stop_minutes` 后再查一次），原因消失后自然停掉；连续 6 次都没停成会放弃并打一行日志，不会无限重试。

`rayrun_sandbox inspect` 的 `idle:` 行显示最近一次判定（原因 + 时间），停在哪个判据上一眼能看出来。

定时器在 Host 内存里，重启即失效（与任务目标、workspace 锁一致）。

## 更新检查

插件启动时查一次 npm registry（`registry.npmjs.org`，失败时回退 `registry.npmmirror.com`），之后每 6 小时一次；同一进程内 5 分钟内不重复请求。检查只发送包名。

- 有更新时，**云电脑**页顶部显示「发现新版本 v{version}（当前 v{current}）」和「立即更新」。
- 点击后 Host 通过 profile 的插件管理器卸载旧版本、安装新版本（精确版本），完成后提示重启 DSH 或刷新页面。
- 只对 registry 安装生效（依赖是 `dsh-rayrun-computer@x.y.z`）。`link:` / `file:` / tgz / `git+` 安装不显示按钮，更新按原来的安装方式重装。
- 安装失败（例如新版本要求更高的 DSH）会尝试装回旧版本，回滚结果写在提示里。
- 包没有发布到 npm 时，检查得到 404 并静默忽略，页面不显示提示。
- 移除自身会让这次请求的响应可能丢失；这种情况页面提示「更新已发起，请重启 DSH 确认」。

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

## 配置项

配置写在 profile 的 `cordis.patch.yml`，覆盖 bundle 里的 `rayrun-cloud` 行：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://api.rayrunos.com/v1` | 部署地址；页面保存的地址优先 |
| `sandboxName` / `sandbox_name` | `dsh-workspace` | 工具缺省机器名，不存在时按 `autoCreate` 创建 |
| `agent` / `default_agent` | `deepseek-harness@1` | 新建机器的默认镜像，也是「新建云电脑」的默认选中项 |
| `cpu_cores` / `memory_mb` | `2` / `2048` | 新建规格 |
| `workspace_mb` | 镜像默认 | 工作区磁盘 |
| `egress_allow` | `[]` | 出向白名单；平台默认完全断网 |
| `credentials` | `[]` | 注入机器的 Rayrun 凭证名 |
| `remote_desktop` | `false` | 工具自动创建机器时是否开启桌面 |
| `autoCreate` | `true` | 机器不存在时是否自动创建 |
| `default_timeout_seconds` | `300` | `rayrun_exec` 缺省超时 |
| `idle_stop_minutes` | `0`（关闭） | 任务结束后空闲多久自动 `stop`；有未 pull 改动时跳过 |
| `token` / `token_file` | 无 / `~/.rayrun/token` | 调试用；`token` 会明文写进 profile，正常请用连接设置 |
| `cloudMode` | `false` | 内部：云上 worker 用，不注册工具 |

只写要改的键，其余走代码默认值；改完重启 DSH。配置按 profile 生效（Desktop 的 patch 只影响 Desktop）。

### Token 与 API 地址

插件按以下顺序解析 Token，命中即停：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 插件 config 的 `token` | 临时调试；会明文留在 profile 配置里 |
| 2 | Harness 凭证库的 `RAYRUN_TOKEN` | 页面「连接设置」写入的位置，推荐 |
| 3 | 环境变量 `RAYRUN_TOKEN` | CI / 脚本启动 |
| 4 | `~/.rayrun/token` | 与 Rayrun CLI 共用，零配置 |

API 地址优先级：页面保存的地址（`~/.rayrun/dsh.json`）→ 插件 config 的 `baseUrl` → 环境变量 `RAYRUN_API_URL` → `https://api.rayrunos.com/v1`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rayrun_sandbox` | create / list / inspect / start / stop / pause / resume / destroy |
| `rayrun_exec` | 执行非交互命令，返回 exit code、stdout、stderr |
| `rayrun_desktop` | 桌面 computer use：`screenshot` 截屏、`click` / `type` / `key` / `scroll` 操作、`probe` 探测 X11 工具 |
| `rayrun_files` | 工作区 list / upload / download |
| `rayrun_agent` | 把整段任务交给机器内 agent，流式等待结果 |
| `rayrun_dsh` | 云上 DSH worker：`sync` 推送并校验图层，`status` 只读比对，`delegate` 委托整段任务；`start` + `result` 不等待地委托与收取 |
| `rayrun_workspace` | 工作区同步：`push` 推送并校验 HEAD/摘要，`pull` 回传 diff 供本地审阅 |

## 桌面自动化（computer use）

`rayrun_desktop` 让模型看屏幕并动手：`screenshot` 把 X11 桌面截成图片交给模型，`click` / `type` / `key` / `scroll` 用像素坐标和 xdotool 操作。适合没有 API 的应用和网站；前提是机器创建时开了远程桌面（`remote_desktop: true`，内存至少 2 GB）。

- **先探测再动手。** `probe` 回报解析到的 `display`、`reachable`，以及 `xdotool` / `scrot` / `import` / `ffmpeg` 是否存在。exec 环境里**没有 `DISPLAY`**，桌面实际跑在 `:99`（从 `/tmp/.X11-unix` 推断，不靠 `:0`）。出厂镜像**不带** xdotool 和 scrot，要先装；但**新建机器默认没有出向网络**，得把镜像自己的 apt 源放进 `egress_allow`——实测镜像是 Ubuntu noble，源是 `mirrors.aliyun.com`：

  ```bash
  apt-get update -qq && apt-get install -y xdotool scrot   # 用 rayrun_exec 执行
  ```

- **2026-11-02 实机验证**：`deepseek-harness@1`、2 GB、开桌面，装完包后 `probe → screenshot → click → type → key` 全部通过。截图 1440×900，PNG 19–37 KB、base64 26–50 KB，离上限很远；`xdotool type` 送进去的 `$(id)` 原样显示、没有被求值。
- **截图以图片块的形式回到模型**，所以当前模型必须声明图片输入；不是的话工具直接报错，而不是塞回一段 base64。
- **截图上限 2.9 MB**（机器侧 stdout 截断在 4 MiB，base64 还要多三分之一）。超了会明确报错，降低桌面分辨率再试。
- **坐标是屏幕像素**：先 `screenshot` 看清再点，动作之后通常再截一张确认。
- **非 ASCII 输入**（中文等）受键盘布局限制，可能打不进去；这类内容优先走命令行或剪贴板。
- 输入文本和按键都以位置参数传给 `/bin/sh -c`，不会拼进脚本文本，所以引号、分号、`$(...)` 都只是字符。

## 安全与边界

- Token 只存在 Host 侧。页面通过 `/plugins/rayrun/rpc` 调用，接口不返回 Token，只返回来源与是否配置。
- RPC 只接受同源 POST（校验 `Origin`），并限制请求体大小。
- 密码只存在内存；Token 只进 Harness 凭证库，或来自你显式设置的 `RAYRUN_TOKEN` / `~/.rayrun/token`。
- Token 文件、`~/.rayrun/dsh.json` 均为用户本机文件；发布包不包含任何 Token。
- 销毁不可恢复：机器和工作区数据一起删除。
- 新建机器默认无出向网络；装包或调用外部 API 需显式配置 `egress_allow`。
- `rayrun_exec` 的 `command` 走 `/bin/sh -c`，`argv` 直接 exec，二者只能给一个。
- 云上 DSH Web 不是常驻入口：Rayrun 只能发布桌面端口 6080，且该 ingress 是 **public**。排障时可以把 6080 让给 `dsh web`，但那是 RCE 级入口，token 等同凭证，用完必须关掉——完整步骤和限制见 [一致性方案](cloud-dsh-parity-plan.md) §4.3。

---

相关文档：[安装指南](installation.md) · [开发与自测](development.md) · [一致性方案](cloud-dsh-parity-plan.md) · [README 中文版](../README.zh-CN.md)
