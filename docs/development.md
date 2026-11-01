# 开发与自测

仓库没有构建步骤，也没有 npm 运行时依赖。`client.js` 由 DSH 直接作为 client module 加载，只 `require('react')` 这类 DSH 提供的内建模块；Host 半区是普通 ESM。

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半区：注册 `rayrun_*` 工具、`/plugins/rayrun/rpc` 路由、任务目标上下文、更新检查 |
| `lib/rayrun.js` | Rayrun 客户端：连接解析、机器/桌面操作、`repairDesktop` |
| `lib/auth.js` | 用户名密码 / 微信登录，登录后自动创建 API Token |
| `lib/update.js` | 版本比较、registry 查询、卸载后重装的更新流程 |
| `lib/cloud-dsh.js` | 云上 worker 图层：投影、`rev` 计算、secret scan |
| `lib/cloud-workspace.js` | workspace push / pull 与云端 `git` 校验 |
| `lib/workspace-lock.js` | 单 writer 锁 |
| `lib/context-pack.js` | handoff 目录的生成与 secret 拦截 |
| `lib/delegate.js` | 委托一轮：prompt、SSE、revs 回显 |
| `lib/desktop.js` | 桌面 computer use：X11 命令构造、截图解码、失败映射 |
| `lib/sse.js` | SSE 解析 |
| `client.js` | Client 半区：侧边栏云电脑页、连接设置、输入区「云上 / 本地」切换 |
| `cordis.patch.yml` | bundle 插入行；`name` 必须与包名一致 |
| `locale/*.json` | 插件卡片标题与描述 |

## 检查

```bash
node --check index.js
node --check lib/rayrun.js
node --check lib/auth.js
node --check lib/cloud-dsh.js
node --check lib/cloud-workspace.js
node --check lib/workspace-lock.js
node --check lib/context-pack.js
node --check lib/delegate.js
node --check lib/desktop.js
node --check lib/sse.js
node --check lib/update.js
node --check client.js
node test/locale-audit.mjs
```

`node test/locale-audit.mjs` 从 `client.js` 里读出 `ZH` / `EN` 两份字典，比对页面实际用到的 key，列出缺失和未使用的条目。

## 测试

```bash
node test/cloud-profile.mjs     # 投影纯逻辑：确定性 rev、manifest、secret scan、图层覆盖项
node test/cloud-workspace.mjs   # 云端 workspace 解析、路径规则、push 摘要与偏离判定
node test/workspace-lock.mjs    # 单 writer 锁的获取/释放/冲突
node test/context-pack.mjs      # handoff 目录结构与 secret 拦截
node test/cloud-tool.mjs        # 用假上下文驱动真实 apply，断言 rayrun_dsh 注册形状与非法 action
node test/desktop.mjs           # rayrun_desktop：参数校验、X11 命令构造、截图解码、图片块渲染
node test/security.mjs          # 负向：跨源 POST、超大 body、未知 action、只读响应不含 token
node test/tool-routing.mjs      # 云上/本地工具路由
node test/update-unit.mjs       # 版本比较、canAutoUpdate、applyUpdate 回滚
node test/update-rpc.mjs        # 用假 Harness 上下文驱动真实 RPC handler
node test/update-rpc.mjs missing  # registry 上没有这个包时的降级
```

- `test/update-rpc.mjs` 覆盖检查、应用、link 安装拒绝、失败回滚；`missing` 场景模拟 404。
- `test/cloud-profile.mjs` 只测纯逻辑，不打 Rayrun API。
- `test/cloud-tool.mjs` 断言注册形状与拒绝路径，不联网。
- 需要真实机器的部分（`rayrun_dsh sync` / `status`、workspace push/pull、delegate）用探针机器联调一次，不要只靠单测。

## 联调

```bash
node test/api-smoke.mjs <sandbox-id>
```

默认连托管 API；本地开发集群用 `RAYRUN_API_URL=http://<dev-host>/v1` 覆盖。这个脚本不在 `files` 里，不会进包。

**实现任何新端点、功能或 wiring 变更后，必须跑一次真实环境验证**，单测不够。

## 刷新 Client bundle

Client 半区只在页面启动时加载。改完 `client.js`：

1. 重启 DSH，或用 `dsh web` 启动时打印的**带认证 token 的 URL** 重新打开页面（裸 `http://127.0.0.1:<port>` 会返回 401）；
2. 确认新 bundle 能从 `/plugins/??dsh-rayrun-computer/client.js&rev=<新 rev>` 取到；
3. 替换/改名已安装的包之后，DSH 进程会缓存旧的 client 包路径，重启是最可靠的刷新方式。

## 约定

- 改包名 / client id 时，必须同步更新 DSH profile 的 bundle 列表和 `link` 依赖，并刷新认证页面。
- `lib/*.js` 必须在 `package.json` 的 `files` 里，否则发布/安装后 Host 半区缺文件。
- Token 不进 Client、不写日志、不进 git；RPC 必须同源。
- 提交用 `feat:`、`fix:`、`chore:`、`docs:`，提交信息用英文。
- 更多改动流程见仓库根目录的 [CLAUDE.md](../CLAUDE.md)。

---

相关文档：[使用手册](usage.md) · [安装指南](installation.md) · [README 中文版](../README.zh-CN.md)
