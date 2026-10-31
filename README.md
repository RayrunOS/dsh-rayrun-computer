# Rayrun 云电脑 — DeepSeek Harness 插件

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
- **创建**：选支持桌面的镜像、vCPU、内存（远程桌面最少 2 GB），自动生成名称。
- **生命周期**：开机、恢复、关机（冷停）、重命名、销毁（带确认）。
- **远程桌面**：机器开启 `remote_desktop` 后，Rayrun 会自动发布镜像的 `desktop_port`（通常是 6080）。插件读取 `sandbox.ingress[].url`，用 iframe 打开，并提供新窗口、全屏、重载。
- **桌面密码**：在机器里执行 `rayrun-desktop status`，把输出（含 VNC 密码）显示在弹窗里，可复制。
- **账户信息**：余额、累计机时、运行中数量。
- **连接设置**：支持用户名/邮箱 + 密码登录、微信登录；登录成功后自动创建 API Token 并存入 Harness 凭证库，也保留手动粘贴 Token 的方式。
- **模型工具**：`rayrun_sandbox` / `rayrun_exec` / `rayrun_files` / `rayrun_agent`，并新增 `remote_desktop` 创建参数。
- **输入区切换**：在 composer 左侧选择「工作任务 · 云上电脑 / 本地电脑」，按会话决定任务在哪台机器上执行。

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

> 本次从 `@local/dsh-plugin-rayrun-cloud` 改名为 `@local/dsh-plugin-rayrun-computer`，就是为了让运行中的 DSH 重新扫描 client 包，而不必重启整个应用。如果当前页面仍显示旧版，重新打开认证 URL 即可。

## 连接 Rayrun

首次打开「云电脑」会要求连接：

- **Rayrun 官网**：`http://rayrunos.com/`。
- **API 地址**：`https://api.rayrunos.com/v1`（托管环境的 API；`rayrunos.com/v1` 是官网 SPA，不是 API），或自托管 / 本地开发的 `<origin>/v1`。
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
- Token 只保存在 Host 侧；页面通过 `/plugins/rayrun/rpc` 调用，接口不返回 Token 明文。
- 仍然保留「API Token」页签，用于粘贴已有 Token 或 CI 场景。

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

## 配置项（`cordis.patch.yml`）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | 代码内 `https://api.rayrunos.com/v1` | 部署地址；页面保存的地址优先 |
| `sandboxName` | `dsh-workspace` | 工具缺省机器名，不存在时按 `autoCreate` 创建 |
| `agent` / `default_agent` | `ubuntu@1` | 新建机器的默认镜像 |
| `cpu_cores` / `memory_mb` | `2` / `2048` | 新建规格 |
| `workspace_mb` | 镜像默认 | 工作区磁盘 |
| `egress_allow` | `[]` | 出向白名单；平台默认完全断网 |
| `credentials` | `[]` | 注入机器的 Rayrun 凭证名 |
| `remote_desktop` | `false` | 工具自动创建机器时是否开启桌面 |
| `autoCreate` | `true` | 机器不存在时是否自动创建 |
| `default_timeout_seconds` | `300` | `rayrun_exec` 缺省超时 |
| `token` / `token_file` | 无 | 见上一节 |

当前 bundle 的 patch 指向托管 API `https://api.rayrunos.com/v1`，官网是 `http://rayrunos.com/`。切到托管环境后，本地开发集群的 token 会返回 401，需要在「云电脑 → 连接设置」里重新粘贴托管环境的 API Token；也可以用 `RAYRUN_API_URL` 或页面保存的地址覆盖。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rayrun_sandbox` | create / list / inspect / start / stop / pause / resume / destroy |
| `rayrun_exec` | 执行非交互命令，返回 exit code、stdout、stderr |
| `rayrun_files` | 工作区 list / upload / download |
| `rayrun_agent` | 把整段任务交给机器内 agent，流式等待结果 |

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
node --check client.js
node test/api-smoke.mjs <sandbox-id>
```

`test/api-smoke.mjs` 只用于联调，不在 `files` 里，不会进包。默认连托管 API；本地开发集群用 `RAYRUN_API_URL=http://<dev-host>/v1` 覆盖。
