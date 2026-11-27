# RPC 授权边界评估（RC-010 / RC-011）

状态：**方案，未改行为**（2026-11-27）。本文只给评估和候选设计，`machine.action`
与 `machine.password` 的实现保持不变，等确认后再动手。

## 1. 现状

`/plugins/rayrun/rpc` 是给插件页面用的同源路由，Host 侧持有 Rayrun token。

- 同源检查：POST 带 `Origin` 时比较 `Origin.host === Host`；不带 `Origin` 的请求
  （curl、非浏览器客户端、部分同源脚本）直接放行。这是 CSRF 防护，不是身份认证。
- `machine.action` 把 `verb` 原样传给 `machineAction()`；`destroy` 与
  start/stop/pause/resume/rename 在同一动作里，RPC 层没有额外确认。
- `machine.password` 执行 `rayrun-desktop status`，把 stdout/stderr 原样返回；
  密码是机器的桌面密码，当前格式就是文本。
- 插件页面在用户点击后调用这些动作；任何同源脚本（其他 client module、XSS、
  开发者工具）也可以调用。Host 无法区分“插件页面”和“同源脚本”。
- 同一路由还能写 credential（`credentials.save`）和执行文件/命令；这些是既有的
  Host 能力。本文只评估 `destroy` 与桌面密码，但长期能力边界会同时覆盖它们。
- 能访问本机 DSH 端口的 OS 用户/进程本来就能读 Harness 凭证和页面，不属于这层
  能防住的威胁。

## 2. 威胁模型

主要风险是**同源代码**和**误操作**，不是本机 OS 用户：

1. 第三方/恶意同源脚本在用户不知情时销毁计费机器或读取桌面密码。
2. XSS 或注入的 client module 调用 RPC。
3. 误触、重放、脚本化批量调用。
4. 页面关闭后遗留的页面脚本继续调用。

同源检查挡不住 1–4；真正的边界只能放在 Host 侧，且不能依赖页面里的 flag。

## 3. 短期方案（低风险，保留现有 UI）

目标：把“破坏性/敏感动作”从普通生命周期动作里分离出来，增加用户意图和审计，
不声称能挡住恶意同源脚本。

1. **拆分动作**
   - `machine.lifecycle`：start / stop / pause / resume / rename。
   - `machine.destroy`：只做 destroy，单独文档、单独审计。
   - 兼容期保留 `machine.action`，但 `destroy` 只接受 `machine.destroy`；迁移
     完成后再移除旧路径。
2. **一次性确认票据**
   - `machine.confirm`：输入 `{ action: "destroy" | "password", id }`，返回
     `{ ticket, expires_at }`。
   - Host 内存保存，60 秒过期，绑定 `action + machine id`，单次消费，限制未消费
     票据数量。
   - `machine.destroy` 必须带 `ticket` 和 `confirm_name`（机器名，服务端比对）；
     `machine.password` 必须带 `ticket` 和 `intent: "open-desktop"`。
   - 票据能降低误操作、重放和盲打 CSRF；**挡不住恶意同源脚本**，因为它也能申请
     票据。文档必须写清楚这一点。
3. **密码输出**
   - `machine.password` 加 `Cache-Control: no-store`、速率限制、仅在 Running 时
     返回；审计记录动作/机器 id/结果，不记录密码。
   - 密码本身是平台静态桌面密码，没有短期密码 API；不要假装票据能让密码过期。
4. **审计**
   - destroy/password 记录时间、动作、机器 id、ticket id、结果；不记录 token、
     密码或 secret。
5. **UI**
   - Destroy 二级确认保持不变；服务端再加 `confirm_name` 和 ticket。
   - Open desktop 时先取 ticket 再取密码；票据过期就重新提示。

## 4. 长期方案（真正的 Host 能力边界）

短期票据不是授权边界。要挡住同源脚本，需要把能力移出 Web 同源面：

- **Host-only 通道**：DSH desktop/CLI 工具、Unix domain socket（0600 权限）或
  需要 OS 用户确认的 Host 服务；Web 页面通过 Host 的授权通道发起，而不是直接
  调 `/plugins/rayrun/rpc`。
- **noVNC 代理**：Host 代理 WebSocket，把密码交给 websockify，页面永远拿不到
  桌面密码；这同时解决 RC-011 的“页面能读密码”问题。
- **DSH 原生确认能力**：如果 DSH 提供 per-plugin capability/confirm API，优先
  使用，不自己造 token。没有原生能力时再考虑 Host-only 通道。
- **能力令牌**：由 Host 生成并只通过页面读不到的通道交付（例如原生 UI/本地
  socket）。只要页面能读到，它就不是边界。

## 5. 不建议

- 只在客户端加确认框/输入机器名：同源脚本可直接调 RPC，绕过 UI。
- 把破坏性动作改名或藏起来：不是授权边界。
- 把 Rayrun token、桌面密码放进 URL、日志或页面全局变量：违反现有约束。
- 用长期 token 区分“可信页面”和“不可信脚本”：同源脚本也能拿到。

## 6. 对 Bots 的结论

- Bots 继续**不暴露 destroy**；空闲策略只用 stop/pause。
- `machine.password` 只在用户明确点击 Open 后调用，不记录、不持久化。
- 在短期票据落地前，Bots 不依赖 RPC 层的额外授权；安全边界与本机 DSH 端口
  的访问控制一致。

## 7. 需要决策

1. 是否接受短期“拆分动作 + 一次性票据 + 审计”？它改善误操作/重放，但不防
   恶意同源脚本。
2. 是否投入长期 Host-only 能力或 noVNC 密码代理？这是唯一能真正把密码/销毁
   从页面拿走的方案。
3. 如果接受，建议单独一个 minor 版本实现，先加动作和票据，再迁移 UI；本版本
   不改行为。
