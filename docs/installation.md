# 安装指南

把 `dsh-rayrun-computer` 装进 DeepSeek Harness 的 profile，并完成第一次连接。

安装分三步：**装包 → 启用 bundle → 连接 Rayrun**。三步都不需要改插件源码。

> 验证基线：DSH Desktop `0.2.1-rc.5`、插件 `2.0.0`（2026-11-01）。
> 插件本身没有 npm 运行时依赖，也没有构建步骤。

---

## 1. 准备

| 项目 | 要求 |
| --- | --- |
| DeepSeek Harness | 已安装，并能打开 UI（Desktop 应用，或 `dsh web`）。本仓库只在 `0.2.1-rc.5` 上验证过，更早版本未测试。 |
| 插件来源 | 本地目录（推荐）、`.tgz` 或 Git 地址。**当前 npm 上没有这个包**：查询 `registry.npmjs.org/dsh-rayrun-computer` 返回 404，按包名安装会失败。 |
| Rayrun 账号 | `rayrunos.com` 账号。登录后插件会自动创建 API Token，也可以手动粘贴已有的 Token。 |
| 网络 | 能访问 `https://api.rayrunos.com/v1`。用 Git 地址或 tarball 安装时，还要能访问对应主机。 |
| 可选 | Chrome 或 Edge：用微信登录时需要本机浏览器。 |

安装前确认选中的是**包根目录**：

```text
dsh-rayrun-computer/
  package.json        # name=dsh-rayrun-computer，dsh.bundle.patch 指向 cordis.patch.yml
  index.js            # Host 半区
  client.js           # Client 半区
  cordis.patch.yml    # bundle 插入的 rayrun-cloud 行
  lib/
```

> 「添加插件」要填**目录**，不是 `index.js`，也不要指向 `node_modules` 里的副本。
> 路径下没有 `package.json`，或 `package.json` 没有 `dsh.bundle.patch`，安装会被拒绝。

---

## 2. 安装

安装动作会做三件事：在 profile 的 `package.json` 里增加依赖、把包名写进 `dsh.profile.bundles`、安装依赖。装完通常要重启 DSH；只有启用了 HMR 的 profile 会即时重组。

### 2.1 桌面端：侧栏「插件」（推荐）

1. 打开 DSH Desktop。首次启动会自动初始化 `desktop` profile。
2. 侧栏进入 **插件**，点 **添加插件**。
3. 在包名输入框里填这个目录的**绝对路径**，例如：
   - Windows：`D:\code\dsh-rayrun-computer`
   - macOS / Linux：`/Users/you/code/dsh-rayrun-computer`
4. 点 **安装**。Host 会先读路径下的 `package.json`，确认它声明了 `dsh.bundle`，再交给 pnpm。
5. 安装完成后点 **立即启用**，或回到插件列表确认「Rayrun 云电脑」卡片的开关已打开。
6. 完全退出并重新打开 DSH Desktop。

说明：

- 本地目录安装会写成 `link:` 依赖；以后改插件代码，重启 DSH 即可生效，不需要重新安装。
- Desktop 和 `dsh web` 用的是**不同的 profile**：Desktop 是 `desktop`，Web 是 `web`。装到其中一个，另一个看不到。
- 如果你刚更新过插件代码，但没有重启，侧栏可能仍是旧版 Client bundle。

### 2.2 命令行

```bash
dsh --version

# 用 dsh web 时
dsh plugin --profile web add /abs/path/to/dsh-rayrun-computer

# Desktop：先完全退出 DSH Desktop，再执行
dsh plugin --profile desktop add /abs/path/to/dsh-rayrun-computer
```

- `dsh plugin` 把参数转给 profile 目录里的 pnpm。本地目录同样写成 `link:` 依赖；安装成功后会把这个新 bundle 追加到 `dsh.profile.bundles`。
- 需要 `pnpm` 在 `PATH` 里。Desktop 侧栏使用应用自带的包管理器，不需要另装。
- Desktop 的 profile 由应用管理，安装前要先退出应用；装完再启动，Host 才会加载新代码。
- 相对路径按**当前终端目录**解析；拿不准就用绝对路径。
- 如果终端里的 `dsh` 不是 Desktop 自带的那一个，`--profile desktop` 会被拒绝；这种情况直接用侧栏安装。

### 2.3 离线 / 固定版本：tarball

在仓库根目录：

```bash
pnpm pack        # 或 npm pack
# → dsh-rayrun-computer-2.0.0.tgz
```

然后在「添加插件」里填 tgz 的绝对路径，或：

```bash
dsh plugin --profile web add /abs/path/dsh-rayrun-computer-2.0.0.tgz
```

tarball 包含 `package.json` 的 `files` 列出的文件（外加 npm 始终会带的 `LICENSE`）：`index.js`、`client.js`、`lib/*.js`、`locale/*.json`、`cordis.patch.yml`、`icon.png`、`README.md`，足够 Host 与 Client 运行。

### 2.4 让 Creator 模式的 agent 代装

在 Creator（创造）模式，或启用了 `tool-plugin-manager` 的 profile 里，让 agent 调：

```text
plugin_manager install_bundle  target = /abs/path/to/dsh-rayrun-computer
```

该工具要求 `danger-full-access`，或为本次调用单独批准。装进来的 Host 代码在 Harness 进程内执行，不受工作区沙箱限制；只安装你信任的来源。

---

## 3. 安装后检查

按顺序检查，任一步失败先看第 7 节。

1. **profile 清单**。打开 `$DSH_HOME/profiles/<profile>/package.json`，依赖和 bundle 应同时出现：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-rayrun-computer"]
       }
     },
     "dependencies": {
       "dsh-rayrun-computer": "link:/abs/path/to/dsh-rayrun-computer"
     }
   }
   ```

2. **侧栏出现「云电脑」**。没有就重启 DSH：Client bundle 只在页面启动时加载。

3. **连接设置能打开**。登录或保存 Token 后显示账户名、余额和累计机时，说明 Host 的 `/plugins/rayrun/rpc` 路由和 Rayrun API 都通了。

4. **工具可用**。让模型执行 `rayrun_sandbox` 的 `list`。还没配置 Token 时，应看到明确的 `token_required` 错误，而不是一句“已完成”。

`$DSH_HOME` 默认是 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`）。

---

## 4. 连接 Rayrun

打开 **云电脑 → 连接设置**：

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| 账号登录 | 有用户名/邮箱和密码 | Host 调 `/auth/login`，成功后自动调 `/tokens` 创建 API Token；密码只存在内存，不落盘、不写日志。 |
| 微信登录 | 部署启用了微信登录 | Host 打开可见的 Rayrun 登录页，扫码后自动创建 Token。需要本机 Chrome/Edge（可用 `RAYRUN_CHROME_PATH` 指定）；没有可用浏览器时退化为手动粘贴 Token。 |
| API Token | CI、已有 Token、微信不可用 | 从 Rayrun 控制台「设置 → 我的 API Token」创建，明文只显示一次。 |

- API 地址默认 `https://api.rayrunos.com/v1`，页面不再显示。自托管用环境变量 `RAYRUN_API_URL=http://<dev-host>/v1`，或写进 `~/.rayrun/dsh.json` 的 `baseUrl`。
- `rayrunos.com/v1` 是官网 SPA，不是 API，不要填。
- Token 只保存在 Host 侧：页面通过同源 RPC 调用，拿不到明文。解析顺序见[使用手册](usage.md#token-与-api-地址)。
- **断开连接**会尝试吊销自动创建的 Token 并清除本机凭据，但不会删除云上的机器。
- 微信登录窗口是可见的浏览器窗口，不是静默自动化；登录完成后窗口自动关闭，临时 profile 会被清理。
- 没有可用浏览器时，微信按钮会退化为打开 Rayrun 登录页；完成登录后回到插件手动粘贴 Token。

---

## 5. 按需配置

配置写在 profile 的 `cordis.patch.yml`，覆盖 bundle 里的 `rayrun-cloud` 行：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: rayrun-cloud
  name: 'dsh-rayrun-computer'
  config:
    sandboxName: dsh-workspace
    idle_stop_minutes: 15
    egress_allow:
      - api.deepseek.com
      - registry.npmmirror.com
```

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `sandboxName` | `dsh-workspace` | 工具默认机器名；机器不存在时按 `autoCreate` 创建 |
| `agent` / `default_agent` | `deepseek-harness@1` | 新建机器的默认镜像 |
| `cpu_cores` / `memory_mb` | `2` / `2048` | 新建规格；远程桌面至少 2048 MB |
| `remote_desktop` | `false` | 工具自动建机器时是否开桌面 |
| `egress_allow` | `[]` | 出向白名单；平台默认完全断网 |
| `credentials` | `[]` | 注入机器的 Rayrun 凭证名 |
| `idle_stop_minutes` | `0` | 任务结束后空闲多久自动 `stop`；有未 pull 改动时跳过 |
| `baseUrl` | `https://api.rayrunos.com/v1` | 默认 API 地址，页面保存的地址优先 |
| `token` / `token_file` | 无 / `~/.rayrun/token` | 调试用；`token` 会明文写进 profile，正常请用连接设置 |

- 只写要改的键，其余走代码默认值；改完重启 DSH。
- **不要**把 Token 写进 `config.token`，也不要提交到仓库。
- 配置按 profile 生效：Desktop 的 patch 只影响 Desktop。
- 包内的 `cordis.patch.yml` 是 bundle 自带的插入行，不要直接改；要改的是 profile 的那一份。

---

## 6. 升级、回退、卸载

### 升级

- **本地目录（link）**：`git pull` 或替换代码，然后重启 DSH。Client bundle 有缓存，重启最可靠。
- **tarball**：重新 `pnpm pack`，在「插件」页先移除旧版再装新 tgz。
- **registry**：当前没有发布，装不了。发布之后，云电脑页会在有新版本时显示「立即更新」；`link:` / `file:` / tgz / git 安装不显示这个按钮，按原来的方式重装。
- 升级前先确认插件版本与 DSH 版本的兼容性。安装被拒绝时，按提示处理，不要跳过检查。

### 回退

装回旧 tgz，或把本地 checkout `git checkout <旧版本>` 后重启。profile 里的依赖和 bundle 选择会保留。

### 卸载

- 界面：**插件 → Rayrun 云电脑 → 移除**，确认后重启 DSH。
- 命令行：`dsh plugin --profile <profile> remove dsh-rayrun-computer`。

卸载只移除依赖和 bundle，不会销毁 Rayrun 上的机器或工作区。自动创建过 Token 的话，先用「断开连接」吊销它。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件页找不到「云电脑」 | bundle 没启用，或装到了别的 profile | 在「插件」页打开开关；确认 Desktop=`desktop`、Web=`web` |
| 安装被拒绝，提示没有 bundle patch | 选中的不是包根目录 | 指向含 `package.json` 且声明 `dsh.bundle.patch` 的目录 |
| 按包名安装 404 / not found | 还没发布到 npm | 改用绝对目录、tgz 或 Git 地址 |
| 装完页面没有变化 | Client bundle 在页面启动时加载，DSH 缓存了旧路径 | 重启 DSH；或用带认证 token 的 URL 重新打开页面 |
| 打开页面返回 401 | `dsh web` 的裸地址不带认证 token | 用启动时打印的认证 URL |
| 云电脑提示没有 Token / `token_required` | 还没连接，或装到了没有凭证的 profile | 在连接设置登录，或设置 `RAYRUN_TOKEN` |
| Rayrun 返回 401 | Token 属于另一个部署（本地开发集群 vs 托管环境） | 用连接设置重新登录，或确认 API 地址与 Token 属于同一部署 |
| 微信登录按钮不可用 | 部署未启用微信登录，或没找到 Chrome/Edge | 用账号登录 / 粘贴 Token；或设置 `RAYRUN_CHROME_PATH` |
| 远程桌面空白 / WebSocket 1011 | 镜像的 `/etc/hosts` 缺少 `localhost`，或 `rayrun-desktop` 没在运行 | 插件连接桌面时会自动修复；重载桌面，仍失败用「新窗口打开」 |
| `dsh plugin` 报 profile 被占用 / EPERM | Desktop 正在运行，或当前环境禁止写 profile | 完全退出 Desktop 后重试；或用侧栏插件页 |
| 装完工具仍不可用 | Host 没重启，或 bundle 被禁用 | 重启 DSH，确认 bundle 开关和 `bundles` 列表 |

---

## 8. 安全边界

- Token 只在 Host 侧；页面通过同源 `/plugins/rayrun/rpc` 调用，接口不返回 Token 明文。
- 密码只存在内存；Token 只进 Harness 凭证库，或来自你显式设置的 `RAYRUN_TOKEN` / `~/.rayrun/token`。
- `destroy` 不可恢复：机器和工作区数据会一起删除。
- 新建机器默认没有出向网络；要装包或调外部 API，先配置 `egress_allow`。
- 第三方 bundle 的 Host 代码在 Harness 进程内执行，安装即代表信任；只装可信来源。

---

相关文档：[README 中文版](../README.zh-CN.md) · [使用手册](usage.md) · [云上/本地一致性方案](cloud-dsh-parity-plan.md)
