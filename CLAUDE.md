# CLAUDE.md

本文件是本仓库的 workspace instructions。只写代码里看不出来、且每次任务都值得知道的事；通用规范不在这里重复。

行为准则采用 Andrej Karpathy 2026 年 1 月关于 LLM 编码问题的 4 条建议，并针对本项目收窄。它们偏向谨慎而非速度；琐碎任务自行判断。

## 1. 先想再写

- 明确说出假设；不确定就问，不要猜。
- 有多个合理解释时，列出来让用户选，不要静默挑一个。
- 有更简单的方案就说，必要时反驳。
- 不清楚就停下来，指出哪里不清楚。

## 2. 简单优先

- 只写解决问题所需的最少代码，不做没要求的功能。
- 不为一次性代码加抽象，不做没要求的可配置性。
- 不为不可能发生的场景加错误处理。
- 200 行能写成 50 行，就重写。
- 自问：资深工程师会觉得这过度设计吗？会，就简化。

## 3. 外科手术式改动

- 只改必须改的地方；不要顺手“改进”相邻代码、注释或格式。
- 不重构没坏的东西；匹配现有风格，即使你会写得不一样。
- 发现无关的死代码，提一句，不要删。
- 只清理**你的改动**产生的孤儿 import/变量/函数。
- 检验标准：每一行 diff 都能直接追溯到用户请求。

## 4. 目标驱动执行

- 把任务转成可验证的成功标准，再开始写。
- 多步骤任务先给简短计划，每步带验证方式：

```text
1. [步骤] → 验证: [检查]
2. [步骤] → 验证: [检查]
```

- 标准要强到能独立循环；弱标准（“让它能跑”）只会反复澄清。

## 项目是什么

`dsh-rayrun-computer`：把 Rayrun 云电脑接进 DeepSeek Harness 的 Cordis bundle。

- `index.js`：Host 半区。注册 `rayrun_*` 工具、`/plugins/rayrun/rpc` 路由、任务目标上下文。
- `lib/rayrun.js`：Rayrun API 客户端、连接解析、机器/桌面操作、`repairDesktop`。
- `lib/auth.js`：用户名密码 / 微信登录，登录后自动创建 API Token。
- `client.js`：DSH Client 半区。侧边栏云电脑页、连接设置、输入区「云上 / 本地电脑」切换。
- `cordis.patch.yml`：bundle 插入行；`name` 必须与包名一致。
- `docs/cloud-dsh-parity-plan.md`：云上/本地 DSH 一致性方案（本地权威）。
- `README.md`：用户视角的安装、配置和功能说明。

改较大功能前，先读 `README.md` 和相关源码；不要凭记忆改。

## 设计原则
* Local-first

## 常用检查

```bash
node --check index.js
node --check client.js
node --check lib/auth.js
node --check lib/rayrun.js
node test/locale-audit.mjs
```

- 没有构建步骤；`client.js` 由 DSH 直接作为 client module 加载。
- `test/api-smoke.mjs` 会打真实 Rayrun API，只在明确需要且已配置凭据时运行。
- 不要为了让检查通过而改测试断言；先确认行为是否符合预期。

## 不能破坏的约束

- **Token 不进 Client、不写日志、不进 git**。Token 只存 Harness 凭证库；密码只存在内存。
- RPC 必须同源；页面拿不到 Token 明文。新增 RPC 动作时保持这一点。
- 托管 API 是 `https://api.rayrunos.com/v1`；`https://rayrunos.com/v1` 是官网 SPA，不是 API。
- Client module id、`package.json` 的 `name`、bundle row 的 `name` 三者保持 `dsh-rayrun-computer` 一致。
- 改包名 / client id 时，必须同步更新 DSH profile 的 bundle 列表和 `link` 依赖，并刷新认证页面；否则旧 client 会缓存。
- 本仓库没有 npm 运行时依赖；Client 保持自包含，只通过 `require('react')` 等 DSH 提供的内建模块加载。
- `lib/*.js` 必须在 `package.json` 的 `files` 里，否则发布/安装后 Host 半区缺文件。
- 云上/本地任务目标是**按 session** 的；Host 重载会清空内存映射，Client 需要重新同步。
- noVNC 桌面依赖 `/etc/hosts` 里有 `localhost`；`repairDesktop` 是修这个 1011 WebSocket 问题的，不要删。
- 不要把本机 profile 路径、账号、Token、VNC 密码写进仓库。

## 改动流程

1. 读相关文件；不确定就按第 1 条先问。
2. 最小 diff；不碰无关代码和格式。
3. 跑上面的检查；UI 改动至少确认新 client bundle 能通过 `/plugins/??dsh-rayrun-computer/client.js&rev=...` 取到。
4. 需要验证 Host 时，用 `status` / `overview` RPC，不打印 Token。
5. 提交用现有风格：`feat:`、`fix:`、`chore:`、`docs:`。
6. 不提交 `.probe*`、`.env`、本地凭据、profile 改动；远程推送只在用户明确要求时做。

## 完成标准

- 语法检查和 locale 审计通过。
- 改动的 RPC / UI 有实际验证证据，而不是“应该可以”。
- 没有引入新依赖、无关重构或 Token 泄漏。
- 用户请求之外的改动为零，或已在回复里明确说明并征得同意。

## 关于git代码提交

- 必须使用英文

## 测试与验证

- 每个模块至少需要单元测试入口；跨模块能力需要集成测试。
- Agent 任务执行应测试：成功、失败、取消、重试、恢复、权限拒绝、人工确认超时。
- 模型相关逻辑必须可 mock，测试不能依赖真实外部模型 API。
- 工具调用必须测试参数校验、超时、错误映射和审计记录。
- 安全相关模块必须包含负向测试。
- 当前还没有统一命令时，不要编造 build/test 命令；先在对应 README 中标记 `TBD`，一旦确定再更新本文件。
- 将任务转化为可验证目标：
  - “添加校验”应转化为”为非法输入写测试，然后让测试通过”。
  - “修复 bug”应转化为”写一个能复现 bug 的测试，然后修复并让测试通过”。
  - “重构 X”应转化为”确保重构前后测试都通过，并说明外部行为不变”。
- 强成功标准应让 Claude 能够独立循环推进；弱成功标准，例如”让它能工作”，通常需要进一步澄清或先补充验收条件。
- 这些规则是否有效，可以用以下信号判断：diff 中不必要修改更少，因过度复杂导致的返工更少，澄清问题出现在实现前而不是错误发生后。

### 实时集成测试（必须执行）

**实现任何新端点、功能或 wiring 变更后，必须运行实时集成测试。** 仅靠单元测试不够 

