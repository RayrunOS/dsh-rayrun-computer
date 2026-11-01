/**
 * Client half of the Rayrun 云电脑 bundle.
 *
 * Adds a first-class 云电脑 entry to the Harness sidebar and a management page:
 * machine cards, a create dialog, connection settings, and an embedded noVNC
 * desktop for machines whose Rayrun deployment publishes a desktop URL.
 *
 * The page talks to the Host half through the same-origin
 * `/plugins/rayrun/rpc` route; it never sees the API token.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rayrun-computer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const RPC = '/plugins/rayrun/rpc'
    const SETTINGS_ID = 'rayrun-cloud'
    const PANEL_ID = 'rayrun'

    /* ------------------------------------------------------------------ */
    /* Transport                                                          */
    /* ------------------------------------------------------------------ */

    class RpcError extends Error {
      constructor(error) {
        super(error?.message || 'Rayrun request failed')
        this.name = 'RpcError'
        this.code = error?.code || 'unknown'
        this.status = error?.status || 0
        this.retryAfterSeconds = error?.retryAfterSeconds || 0
      }
    }

    async function readJson(res) {
      const text = await res.text()
      try {
        return text ? JSON.parse(text) : {}
      } catch {
        throw new RpcError({ code: 'bad_response', message: `HTTP ${res.status}` })
      }
    }

    async function rpc(action, payload = {}) {
      let res
      try {
        res = await fetch(RPC, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...payload }),
        })
      } catch {
        throw new RpcError({ code: 'network', message: 'The local Rayrun route is unreachable.' })
      }
      const data = await readJson(res)
      if (!data.ok) throw new RpcError(data.error)
      return data
    }

    async function rpcGet(action) {
      let res
      try {
        res = await fetch(`${RPC}?action=${encodeURIComponent(action)}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        })
      } catch {
        throw new RpcError({ code: 'network', message: 'The local Rayrun route is unreachable.' })
      }
      const data = await readJson(res)
      if (!data.ok) throw new RpcError(data.error)
      return data
    }

    function errorText(error, t) {
      if (!error) return ''
      if (error.code === 'network') return t.errNetwork
      if (error.code === 'invalid_credentials') return t.errInvalidCredentials
      if (error.code === 'login_disabled') return t.errLoginDisabled
      if (error.code === 'too_many_attempts') return tf(t, 'errTooManyAttempts', { seconds: error.retryAfterSeconds || 60 })
      if (error.code === 'wechat_not_configured') return t.errWechatNotConfigured
      if (error.code === 'wechat_state_invalid') return t.errWechatExpired
      if (error.code === 'wechat_cancelled') return t.errWechatCancelled
      if (error.code === 'wechat_busy') return t.errWechatBusy
      if (error.code === 'login_no_session') return t.errLoginNoSession
      if (error.code === 'token_create_failed') return t.errTokenCreate
      if (error.code === 'username_required' || error.code === 'password_required') return t.loginFieldsRequired
      if (String(error.code || '').startsWith('wechat_')) return error.message || t.loginWechatFailed
      if (error.code === 'token_required' || error.status === 401) return t.errUnauthorized
      if (error.code === 'invalid_base_url') return t.errBaseUrl
      if (error.code === 'invalid_name') return t.errName
      if (error.code === 'not_found' || error.status === 404) return t.errNotFound
      if (error.name === 'TypeError') return t.errNetwork
      return error.message || t.errGeneric
    }

    /* ------------------------------------------------------------------ */
    /* Formatting                                                         */
    /* ------------------------------------------------------------------ */

    function tf(t, key, vars) {
      return String(t[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (vars && vars[name] != null ? String(vars[name]) : ''))
    }

    function hostOf(url) {
      try {
        return new URL(url).host
      } catch {
        return url || ''
      }
    }

    function formatMoney(balance, currency) {
      if (!balance || typeof balance.balance_cents !== 'number') return '—'
      const symbol = balance.currency === 'CNY' || !balance.currency ? '¥' : `${balance.currency} `
      return `${symbol}${(balance.balance_cents / 100).toFixed(2)}`
    }

    function formatHours(usage) {
      const hours = Number(usage?.vm_hours)
      if (!Number.isFinite(hours)) return '—'
      return `${hours.toFixed(1)} h`
    }

    function agentDescription(agents, ref) {
      const found = (agents || []).find((item) => item.ref === ref || item.name === ref)
      return found?.description || ''
    }

    function statusMeta(status, t) {
      switch (status) {
        case 'Running':
          return { label: t.status_running, color: 'var(--dsw-alias-state-success-primary)' }
        case 'Paused':
          return { label: t.status_paused, color: 'var(--dsw-alias-state-warn-primary)' }
        case 'Stopped':
          return { label: t.status_stopped, color: 'var(--dsw-alias-state-idle-primary)' }
        case 'Terminated':
          return { label: t.status_terminated, color: 'var(--dsw-alias-state-error-primary)' }
        default:
          return { label: status || '—', color: 'var(--dsw-alias-state-idle-primary)' }
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(String(value ?? ''))
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                              */
    /* ------------------------------------------------------------------ */

    function glyph(size, children, extra) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          ...(extra || {}),
        },
        children,
      )
    }

    const I = {
      refresh: (s = 16) =>
        glyph(s, [
          h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.6 6' }),
          h('path', { key: 'b', d: 'M20 4v7h-7' }),
        ]),
      plus: (s = 16) => glyph(s, [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })]),
      settings: (s = 16) =>
        glyph(s, [
          h('circle', { key: 'a', cx: 12, cy: 12, r: 3 }),
          h('path', {
            key: 'b',
            d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z',
          }),
        ]),
      monitor: (s = 20) =>
        glyph(s, [
          h('rect', { key: 'a', x: 2.5, y: 4, width: 19, height: 13, rx: 2.4 }),
          h('path', { key: 'b', d: 'M9 21h6M12 17v4' }),
          h('path', { key: 'c', d: 'M7.4 13.4a2.9 2.9 0 0 1 .6-3.2 3.7 3.7 0 0 1 6.2.2 2.7 2.7 0 0 1 1.3 5' }),
        ]),
      terminal: (s = 20) =>
        glyph(s, [
          h('rect', { key: 'a', x: 2.5, y: 4, width: 19, height: 16, rx: 2.4 }),
          h('path', { key: 'b', d: 'm6.5 9 3 3-3 3M12.5 15h5' }),
        ]),
      power: (s = 16) =>
        glyph(s, [h('path', { key: 'a', d: 'M12 3v9' }), h('path', { key: 'b', d: 'M6.4 6.6a8 8 0 1 0 11.2 0' })]),
      play: (s = 16) => glyph(s, [h('path', { key: 'a', d: 'M8 5.5v13l10-6.5Z' })]),
      more: (s = 16) =>
        glyph(s, [
          h('circle', { key: 'a', cx: 5.5, cy: 12, r: 1 }),
          h('circle', { key: 'b', cx: 12, cy: 12, r: 1 }),
          h('circle', { key: 'c', cx: 18.5, cy: 12, r: 1 }),
        ]),
      external: (s = 15) =>
        glyph(s, [
          h('path', { key: 'a', d: 'M14 4h6v6' }),
          h('path', { key: 'b', d: 'M20 4 11 13' }),
          h('path', { key: 'c', d: 'M19 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10' }),
        ]),
      expand: (s = 16) =>
        glyph(s, [
          h('path', { key: 'a', d: 'M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5' }),
        ]),
      back: (s = 16) => glyph(s, [h('path', { key: 'a', d: 'M15 5l-7 7 7 7' })]),
      key: (s = 16) =>
        glyph(s, [
          h('circle', { key: 'a', cx: 8, cy: 8, r: 4 }),
          h('path', { key: 'b', d: 'm11 11 9 9M17 17l2-2M14 14l2-2' }),
        ]),
      trash: (s = 15) =>
        glyph(s, [
          h('path', { key: 'a', d: 'M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13' }),
          h('path', { key: 'b', d: 'M10 11v5M14 11v5' }),
        ]),
      edit: (s = 15) =>
        glyph(s, [
          h('path', { key: 'a', d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z' }),
          h('path', { key: 'b', d: 'm13.5 7.5 3 3' }),
        ]),
      close: (s = 16) => glyph(s, [h('path', { key: 'a', d: 'M6 6l12 12M18 6 6 18' })]),
      laptop: (s = 13) =>
        glyph(s, [
          h('rect', { key: 'a', x: 3.2, y: 5, width: 17.6, height: 11, rx: 2 }),
          h('path', { key: 'b', d: 'M2 19h20' }),
        ]),
      wechat: (s = 15) =>
        glyph(s, [
          h('path', { key: 'a', d: 'M4 5.5h11a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-4.5 2v-9A2.5 2.5 0 0 1 4 5.5Z' }),
          h('path', { key: 'b', d: 'M8 9.5h.01M11 9.5h.01M14 9.5h.01' }),
        ]),
      cloud: (s = 34) =>
        glyph(s, [h('path', { key: 'a', d: 'M7 18h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 7 11a3.5 3.5 0 0 0 0 7Z' })]),
      alert: (s = 18) =>
        glyph(s, [h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }), h('path', { key: 'b', d: 'M12 7v6M12 16.5v.5' })]),
      check: (s = 16) => glyph(s, [h('path', { key: 'a', d: 'm5 12.5 4.5 4.5L19 7' })]),
    }

    /* ------------------------------------------------------------------ */
    /* Theme CSS                                                          */
    /* ------------------------------------------------------------------ */

    // The composer toggle lives outside the 云电脑 panel, so it carries its
    // own style element; the panel's CSS is only mounted while that page is open.
    const TARGET_CSS = `
.rr-target{display:inline-flex;align-items:center;gap:8px;height:28px;min-width:0;max-width:100%}
.rr-target-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;padding-right:1px}
.rr-target-seg{display:inline-flex;align-items:center;gap:6px;min-width:0}
.rr-target-seg button{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .12s,color .12s,border-color .12s,box-shadow .12s}
.rr-target-seg button:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rr-target-seg button.on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:600;box-shadow:0 1px 2px rgba(2,6,23,.14)}
.rr-target-seg button.on:hover{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);filter:brightness(1.05)}
.rr-target-seg button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.rr-target-seg button svg{width:13px;height:13px;flex:none}
.rr-target-error{width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-size:10px;font-weight:700;line-height:1;flex:none}
@media (max-width:640px){.rr-target-label{display:none}}
`

    const CSS = `
.rr-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden}
.rr-header{display:flex;align-items:flex-start;gap:16px;padding:18px 28px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}
.rr-title{font-size:20px;line-height:28px;font-weight:600;margin:0;letter-spacing:-.01em}
.rr-sub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rr-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none;padding-top:2px}
.rr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s}
.rr-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rr-btn:disabled{opacity:.45;cursor:not-allowed}
.rr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:500}
.rr-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.rr-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.rr-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.rr-iconbtn{width:32px;height:32px;padding:0;border-radius:8px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.rr-iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rr-iconbtn:disabled{opacity:.4;cursor:not-allowed}
.rr-scroll{flex:1;overflow:auto;min-height:0}
.rr-container{max-width:1120px;margin:0 auto;padding:20px 28px 48px}
.rr-summary{display:flex;align-items:center;gap:30px;padding:14px 18px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;margin-bottom:18px}
.rr-stat span{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
.rr-stat b{font-size:17px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums}
.rr-summary-right{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.rr-summary-right em{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.rr-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-bottom:16px}
.rr-banner .rr-btn{margin-left:auto;height:28px;font-size:12px;color:var(--dsw-alias-label-primary)}
.rr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.rr-card{position:relative;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;display:flex;flex-direction:column;transition:border-color .15s,transform .15s,box-shadow .15s}
.rr-card:hover{border-color:var(--dsw-alias-border-l2);transform:translateY(-1px);box-shadow:0 6px 20px rgba(2,6,23,.07)}
.rr-cover{position:relative;aspect-ratio:16/9;border-radius:14px 14px 0 0;background:linear-gradient(135deg,#0a1020,#131f3a 55%,#1b2a4a);overflow:hidden}
.rr-cover:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(148,163,184,.075) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.075) 1px,transparent 1px);background-size:28px 28px;mask-image:linear-gradient(180deg,rgba(0,0,0,.8),transparent 85%);-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,.8),transparent 85%)}
.rr-cover-glow{position:absolute;width:190px;height:190px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.22),transparent 65%);top:-48px;right:-34px}
.rr-cover-art{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(226,232,240,.5)}
.rr-cover-brand{position:absolute;right:12px;bottom:9px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:rgba(148,163,184,.62)}
.rr-pill{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;background:rgba(8,13,24,.55);border:.5px solid rgba(255,255,255,.14);color:#e2e8f0;font-size:11px;line-height:1;backdrop-filter:blur(6px)}
.rr-chip{position:absolute;top:10px;right:10px;height:22px;display:inline-flex;align-items:center;padding:0 8px;border-radius:999px;background:rgba(8,13,24,.4);border:.5px solid rgba(255,255,255,.1);color:rgba(226,232,240,.72);font-size:10px}
.rr-card-body{padding:12px 14px 13px;display:flex;flex-direction:column;gap:10px;flex:1;min-width:0}
.rr-card-name{display:flex;align-items:flex-start;gap:8px;min-width:0}
.rr-name{font-size:14px;font-weight:600;line-height:20px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-image{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin:1px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-meta{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.rr-card-foot{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:2px}
.rr-grow{flex:1;min-width:0}
.rr-menu{position:absolute;right:10px;bottom:54px;min-width:168px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 30px rgba(2,6,23,.2);padding:4px;z-index:20}
.rr-menu button{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.rr-menu button:hover{background:var(--dsw-alias-bg-layer-2)}
.rr-menu button.danger{color:var(--dsw-alias-state-error-primary)}
.rr-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:64px 24px 72px}
.rr-empty-art{width:104px;height:104px;border-radius:28px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:linear-gradient(140deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent));border:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent);margin-bottom:18px}
.rr-empty h2{font-size:17px;line-height:26px;font-weight:600;margin:0 0 6px}
.rr-empty p{max-width:420px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);margin:0 0 20px}
.rr-setup{max-width:560px;margin:34px auto 0}
.rr-setup-card{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px}
.rr-setup-head{display:flex;align-items:center;gap:12px}
.rr-setup-icon{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);flex:none}
.rr-setup-head h2{font-size:16px;line-height:24px;font-weight:600;margin:0}
.rr-setup-head p{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:2px 0 0}
.rr-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.rr-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rr-input,.rr-select{height:36px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:13px;min-width:0}
.rr-input:focus,.rr-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.rr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rr-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin:0}
.rr-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin:0}
.rr-ok{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);margin:0}
.rr-error{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);margin:0}
.rr-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.rr-skeleton{height:250px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l1);background:linear-gradient(100deg,var(--dsw-alias-bg-layer-1) 30%,var(--dsw-alias-bg-layer-2) 50%,var(--dsw-alias-bg-layer-1) 70%);background-size:200% 100%;animation:rr-shimmer 1.4s linear infinite}
@keyframes rr-shimmer{0%{background-position:180% 0}100%{background-position:-20% 0}}
.rr-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:120;max-width:min(520px,calc(100vw - 48px));padding:9px 14px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px rgba(2,6,23,.18);font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-primary)}
.rr-modal-backdrop{position:fixed;inset:0;z-index:80;background:rgba(2,6,23,.46);display:flex;align-items:center;justify-content:center;padding:24px}
.rr-modal{width:min(540px,100%);max-height:calc(100vh - 48px);overflow:auto;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 24px 70px rgba(2,6,23,.35);padding:20px}
.rr-modal-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.rr-modal-head h2{font-size:16px;line-height:24px;font-weight:600;margin:0}
.rr-modal-head p{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:2px 0 0}
.rr-modal-head .rr-iconbtn{margin-left:auto;margin-top:-4px;margin-right:-4px}
.rr-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.rr-modal-body{display:flex;flex-direction:column;gap:14px}
.rr-seg{display:flex;gap:6px;flex-wrap:wrap}
.rr-seg button{height:32px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.rr-seg button:hover{background:var(--dsw-alias-bg-layer-2)}
.rr-seg button.on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:500}
.rr-seg button:disabled{opacity:.4;cursor:not-allowed}
.rr-desktop{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);overflow:hidden}
.rr-dbar{display:flex;align-items:center;gap:10px;height:54px;padding:0 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;background:var(--dsw-alias-bg-base)}
.rr-dtitle{display:flex;flex-direction:column;min-width:0}
.rr-dname{font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-dstatus{display:flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.rr-dactions{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}
.rr-stage{position:relative;flex:1;min-height:0;background:#05070d}
.rr-frame{display:block;width:100%;height:100%;border:0;background:#05070d}
.rr-stage-mask{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#05070d;color:#94a3b8;font-size:12px;text-align:center;padding:24px}
.rr-stage-mask .rr-spin{width:22px;height:22px;border-radius:50%;border:2px solid rgba(148,163,184,.28);border-top-color:#38bdf8;animation:rr-spin .9s linear infinite}
@keyframes rr-spin{to{transform:rotate(360deg)}}
.rr-nodesktop{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:36px;color:#cbd5e1}
.rr-nodesktop-art{width:88px;height:88px;border-radius:24px;display:flex;align-items:center;justify-content:center;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.18);color:#94a3b8;margin-bottom:18px}
.rr-nodesktop h2{font-size:17px;line-height:26px;font-weight:600;margin:0 0 8px;color:#e2e8f0}
.rr-nodesktop p{max-width:520px;font-size:12.5px;line-height:21px;color:#94a3b8;margin:0 0 18px}
.rr-nodesktop .rr-spec{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;font-size:11px;color:#94a3b8;margin-bottom:20px}
.rr-nodesktop .rr-btn{border-color:rgba(148,163,184,.32);color:#e2e8f0}
.rr-nodesktop .rr-btn:hover{background:rgba(148,163,184,.12)}
.rr-dfoot{height:34px;display:flex;align-items:center;gap:10px;padding:0 16px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none;background:var(--dsw-alias-bg-base)}
.rr-dfoot button{margin-left:auto}
.rr-code{margin:0;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto}
.rr-settings{display:flex;flex-direction:column;gap:14px;max-width:720px;color:var(--dsw-alias-label-primary)}
.rr-settings h2{font-size:16px;line-height:24px;font-weight:500;margin:0}
.rr-settings>p{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);margin:0}
.rr-panel{display:flex;flex-direction:column;gap:14px;padding:14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.rr-inline-status{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rr-login-pane{display:flex;flex-direction:column;gap:10px}
.rr-login-tabs{display:inline-flex;align-self:flex-start;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.rr-login-tabs button{height:28px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;white-space:nowrap;cursor:pointer}
.rr-login-tabs button.on{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.rr-login-tabs button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.rr-login-or{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}
.rr-login-or:before,.rr-login-or:after{content:"";height:.5px;flex:1;background:var(--dsw-alias-border-l1)}
.rr-wechat{background:#07C160;border-color:transparent;color:#fff;font-weight:500}
.rr-wechat:hover{background:#07C160;filter:brightness(1.05)}
.rr-wechat:disabled{opacity:.5}
.rr-login-flow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rr-login-flow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rr-login-flow .rr-btn{height:26px;font-size:12px;flex:none}
.rr-login-foot{display:flex;justify-content:flex-end;margin-top:2px}
`

    /* ------------------------------------------------------------------ */
    /* Locale                                                             */
    /* ------------------------------------------------------------------ */

    const ZH = {
      nav: '云电脑',
      title: '云电脑',
      subtitle: 'Rayrun 云端 Linux 电脑，浏览器里随开随用',
      newMachine: '新建云电脑',
      refresh: '刷新',
      settings: '连接设置',
      taskTarget: '工作任务',
      taskTargetCloud: '云上电脑',
      taskTargetLocal: '本地电脑',
      taskTargetHint: '选择这条任务在哪台电脑上执行',
      loginTabAccount: '账号登录',
      loginTabToken: 'API Token',
      loginUsername: '用户名或邮箱',
      loginUsernamePlaceholder: 'Rayrun 用户名或邮箱',
      loginPassword: '密码',
      loginPasswordPlaceholder: 'Rayrun 登录密码',
      loginAction: '登录并自动创建 Token',
      loginBusy: '正在登录…',
      loginOr: '或',
      loginWeChat: '微信登录',
      loginWeChatWaiting: '等待微信扫码…',
      loginWeChatWindow: '已在浏览器打开 Rayrun 登录页，请扫码或完成登录。',
      loginWeChatAuthorizing: '正在完成登录并创建 Token…',
      loginWeChatCancel: '取消',
      loginWeChatBrowser: '已打开 Rayrun 登录页；完成微信登录后回到这里，用 API Token 连接。',
      loginWeChatUnavailable: '此部署未启用微信登录。',
      loginWechatOk: '登录成功，已自动创建并保存 API Token。',
      loginPasswordOk: '登录成功，已自动创建并保存 API Token。',
      loginFieldsRequired: '请填写用户名和密码。',
      loginAccountHint: '登录成功后自动创建 API Token；密码不会保存，Token 只进本机凭证库。',
      loginTokenHint: '已有 Token 可直接粘贴；Token 只保存在本机凭证库。',
      loginAutoToken: '自动创建',
      loginLogout: '断开连接',
      loginLogoutConfirm: '断开当前 Rayrun 连接并清除本机凭证？已自动创建的 Token 会尝试吊销。',
      loginLoggedOut: '已断开并清除本机凭据。',
      loginWechatFailed: '微信登录没有完成。',
      errInvalidCredentials: '用户名或密码不正确。',
      errLoginDisabled: '此部署未启用密码登录。',
      errTooManyAttempts: '尝试次数过多，{seconds} 秒后再试。',
      errWechatNotConfigured: '此部署未启用微信登录。',
      errWechatExpired: '微信登录已过期，请重新发起。',
      errWechatCancelled: '已取消微信登录。',
      errWechatBusy: '微信登录繁忙，请稍后再试。',
      errLoginNoSession: '登录成功但未拿到会话 Cookie，请改用 API Token。',
      errTokenCreate: '登录成功但自动创建 Token 失败，请稍后重试或手动创建。',
      balance: '账户余额',
      hours: '累计机时',
      running: '运行中',
      connectedTo: '已连接',
      loading: '正在读取云电脑…',
      errorTitle: '暂时连不上 Rayrun',
      retry: '重试',
      openSettings: '检查连接设置',
      emptyTitle: '还没有云电脑',
      emptyBody: '创建一台 Rayrun 云电脑，几秒后就能在浏览器里使用完整的 Linux 桌面。',
      createFirst: '创建第一台云电脑',
      setupTitle: '连接 Rayrun',
      setupBody: '粘贴 Rayrun API Token，即可创建并打开云电脑。Token 只保存在本机的 Harness 凭证库。',
      connect: '连接',
      connectStarting: '正在开机…',
      powerOn: '开机',
      resume: '恢复',
      shutdown: '关机',
      more: '更多',
      rename: '重命名',
      destroy: '销毁',
      openExternal: '在浏览器打开',
      status_running: '运行中',
      status_stopped: '已关机',
      status_paused: '已暂停',
      status_terminated: '已销毁',
      cardDesktop: '远程桌面',
      cardSandbox: '命令行沙箱',
      spec: '{cpu} vCPU · {mem} GB',
      usageHours: '{hours} 机时',
      desktopBack: '返回云电脑列表',
      desktopPassword: '桌面密码',
      desktopPasswordLabel: '桌面密码',
      desktopPasswordAuto: '已自动填入；如仍提示，请复制粘贴',
      desktopPasswordLoading: '正在读取桌面密码…',
      desktopPasswordMissing: '没有读到桌面密码，请点右侧「桌面密码」查看',
      desktopReload: '重新载入桌面',
      desktopFullscreen: '全屏',
      desktopExternal: '新窗口打开',
      desktopNotReady: '正在连接桌面…',
      noDesktopNotEnabled: '这台机器创建时没有开启远程桌面。云电脑需要在创建时启用远程桌面，请新建一台。',
      noDesktopNotPublished: '这台云电脑还没有发布桌面端口。',
      noDesktopNoIngress: '当前 Rayrun 部署没有返回桌面地址（入向访问未启用）。你仍然可以用 DSH 的 Rayrun 工具在这台机器上执行命令。',
      noDesktopUnknown: '桌面地址暂时不可用。',
      noDesktopTitle: '桌面还没有就绪',
      desktopFoot: '桌面由 Rayrun 提供。若页面空白，请在新窗口打开。',
      passwordTitle: '桌面密码',
      passwordLoading: '正在读取桌面密码…',
      passwordHint: '在云电脑里运行 rayrun-desktop status 的输出如下。打开桌面时按提示输入密码。',
      passwordEmpty: '没有读到输出。',
      copy: '复制',
      copied: '已复制',
      close: '关闭',
      createTitle: '新建云电脑',
      nameLabel: '名称',
      namePlaceholder: '例如 design-box',
      imageLabel: '镜像',
      imageHint: '支持远程桌面的镜像才能作为云电脑。',
      specLabel: '规格',
      cpuLabel: 'vCPU',
      memoryLabel: '内存',
      createHint: '创建约需 15 秒；远程桌面至少需要 2 GB 内存。',
      create: '创建并打开',
      creating: '正在创建云电脑…',
      cancel: '取消',
      settingsTitle: 'Rayrun 连接',
      baseUrlLabel: 'API 地址',
      baseUrlHint: '填写部署的 <origin>/v1，例如 https://api.rayrunos.com/v1。',
      tokenLabel: 'API Token',
      tokenKeep: '已配置，留空保持不变',
      tokenPlaceholder: '粘贴 Rayrun API Token',
      save: '保存',
      saving: '保存中…',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接成功：{agents} 个镜像，{machines} 台机器。',
      source_saved: '页面设置',
      source_config: '插件配置',
      source_env: '环境变量',
      source_default: '默认地址',
      source_credentials: '凭证库',
      source_file: '令牌文件',
      renameTitle: '重命名云电脑',
      renameLabel: '新名称',
      destroyTitle: '销毁云电脑',
      destroyBody: '确定销毁「{name}」？机器和工作区数据会一起删除，无法恢复。',
      destroyConfirm: '销毁',
      destroying: '正在销毁…',
      created: '云电脑已创建',
      destroyed: '云电脑已销毁',
      actionDone: '操作已提交',
      saved: '连接设置已保存',
      errUnauthorized: 'Rayrun 拒绝了这个 Token（401）。请在连接设置里用账号登录，或粘贴新的 API Token。',
      errNetwork: '连不上 Rayrun。请检查 API 地址和网络。',
      errName: '名称需要 1–64 个字符。',
      errBaseUrl: 'API 地址必须是完整的 http(s) URL。',
      errNotFound: '找不到这台云电脑。',
      errGeneric: '操作没有完成。',
      tokenStatus: 'Token 来源：{source}',
      notConfigured: '未配置 Token',
      selectImage: '选择镜像',
      passwordRequiresRunning: '请先开机再读取桌面密码。',
    }

    const EN = {
      nav: 'Cloud Computer',
      title: 'Cloud Computer',
      subtitle: 'Rayrun Linux desktops in the browser, ready when you are',
      newMachine: 'New computer',
      refresh: 'Refresh',
      settings: 'Connection settings',
      taskTarget: 'Task runs on',
      taskTargetCloud: 'Cloud computer',
      taskTargetLocal: 'Local computer',
      taskTargetHint: 'Choose which computer this task runs on',
      loginTabAccount: 'Sign in',
      loginTabToken: 'API token',
      loginUsername: 'Username or email',
      loginUsernamePlaceholder: 'Rayrun username or email',
      loginPassword: 'Password',
      loginPasswordPlaceholder: 'Rayrun password',
      loginAction: 'Sign in and create a token',
      loginBusy: 'Signing in…',
      loginOr: 'or',
      loginWeChat: 'WeChat login',
      loginWeChatWaiting: 'Waiting for WeChat…',
      loginWeChatWindow: 'The Rayrun login page is open in your browser; scan the code or sign in there.',
      loginWeChatAuthorizing: 'Completing sign-in and creating a token…',
      loginWeChatCancel: 'Cancel',
      loginWeChatBrowser: 'The Rayrun login page opened; after WeChat sign-in, come back and connect with an API token.',
      loginWeChatUnavailable: 'WeChat login is not enabled on this deployment.',
      loginWechatOk: 'Signed in; a new API token was created and saved.',
      loginPasswordOk: 'Signed in; a new API token was created and saved.',
      loginFieldsRequired: 'Enter your username and password.',
      loginAccountHint: 'A token is created automatically after sign-in; your password is never stored.',
      loginTokenHint: 'Paste an existing token; it is stored only in the local credential store.',
      loginAutoToken: 'Auto-created',
      loginLogout: 'Disconnect',
      loginLogoutConfirm: 'Disconnect Rayrun and clear the local credential? The auto-created token will be revoked if possible.',
      loginLoggedOut: 'Disconnected and cleared local credentials.',
      loginWechatFailed: 'WeChat sign-in did not complete.',
      errInvalidCredentials: 'Incorrect username or password.',
      errLoginDisabled: 'Password login is disabled on this deployment.',
      errTooManyAttempts: 'Too many attempts; try again in {seconds}s.',
      errWechatNotConfigured: 'WeChat login is not enabled on this deployment.',
      errWechatExpired: 'The WeChat login expired; start it again.',
      errWechatCancelled: 'WeChat sign-in was cancelled.',
      errWechatBusy: 'WeChat login is busy; try again shortly.',
      errLoginNoSession: 'Signed in but no session cookie was returned; use an API token instead.',
      errTokenCreate: 'Signed in but automatic token creation failed; retry or create a token manually.',
      balance: 'Balance',
      hours: 'Total hours',
      running: 'Running',
      connectedTo: 'Connected to',
      loading: 'Loading cloud computers…',
      errorTitle: 'Cannot reach Rayrun',
      retry: 'Retry',
      openSettings: 'Check connection',
      emptyTitle: 'No cloud computers yet',
      emptyBody: 'Create a Rayrun cloud computer and use a full Linux desktop in the browser in seconds.',
      createFirst: 'Create your first computer',
      setupTitle: 'Connect Rayrun',
      setupBody: 'Paste a Rayrun API token to create and open cloud computers. The token is stored only in the local Harness credential store.',
      connect: 'Connect',
      connectStarting: 'Starting…',
      powerOn: 'Start',
      resume: 'Resume',
      shutdown: 'Shut down',
      more: 'More',
      rename: 'Rename',
      destroy: 'Destroy',
      openExternal: 'Open in browser',
      status_running: 'Running',
      status_stopped: 'Stopped',
      status_paused: 'Paused',
      status_terminated: 'Destroyed',
      cardDesktop: 'Remote desktop',
      cardSandbox: 'CLI sandbox',
      spec: '{cpu} vCPU · {mem} GB',
      usageHours: '{hours} vm-h',
      desktopBack: 'Back to cloud computers',
      desktopPassword: 'Desktop password',
      desktopPasswordLabel: 'Desktop password',
      desktopPasswordAuto: 'Filled automatically; if prompted, copy and paste it',
      desktopPasswordLoading: 'Reading the desktop password…',
      desktopPasswordMissing: 'No desktop password found; open “Desktop password” on the right',
      desktopReload: 'Reload desktop',
      desktopFullscreen: 'Fullscreen',
      desktopExternal: 'Open in new window',
      desktopNotReady: 'Connecting to the desktop…',
      noDesktopNotEnabled: 'This machine was created without a remote desktop. Cloud computers need the desktop enabled at creation time; create a new one.',
      noDesktopNotPublished: 'This cloud computer has not published its desktop port.',
      noDesktopNoIngress: 'This Rayrun deployment returned no desktop URL (inbound access is not enabled). You can still run commands on this machine with the DSH Rayrun tools.',
      noDesktopUnknown: 'The desktop address is not available yet.',
      noDesktopTitle: 'Desktop is not ready',
      desktopFoot: 'Desktop provided by Rayrun. If the page stays blank, open it in a new window.',
      passwordTitle: 'Desktop password',
      passwordLoading: 'Reading the desktop password…',
      passwordHint: 'Output of rayrun-desktop status inside the cloud computer. Enter it when the desktop asks for a password.',
      passwordEmpty: 'No output was returned.',
      copy: 'Copy',
      copied: 'Copied',
      close: 'Close',
      createTitle: 'New cloud computer',
      nameLabel: 'Name',
      namePlaceholder: 'e.g. design-box',
      imageLabel: 'Image',
      imageHint: 'Only images with remote-desktop support can open a desktop.',
      specLabel: 'Size',
      cpuLabel: 'vCPU',
      memoryLabel: 'Memory',
      createHint: 'Creation takes about 15 seconds; a remote desktop needs at least 2 GB of memory.',
      create: 'Create and open',
      creating: 'Creating the cloud computer…',
      cancel: 'Cancel',
      settingsTitle: 'Rayrun connection',
      baseUrlLabel: 'API address',
      baseUrlHint: 'Use <origin>/v1 for your deployment, for example https://api.rayrunos.com/v1.',
      tokenLabel: 'API token',
      tokenKeep: 'Configured; leave blank to keep it',
      tokenPlaceholder: 'Paste a Rayrun API token',
      save: 'Save',
      saving: 'Saving…',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connected: {agents} images, {machines} machines.',
      source_saved: 'Page setting',
      source_config: 'Plugin config',
      source_env: 'Environment',
      source_default: 'Default',
      source_credentials: 'Credential store',
      source_file: 'Token file',
      renameTitle: 'Rename cloud computer',
      renameLabel: 'New name',
      destroyTitle: 'Destroy cloud computer',
      destroyBody: 'Destroy “{name}”? The machine and its workspace data are deleted permanently.',
      destroyConfirm: 'Destroy',
      destroying: 'Destroying…',
      created: 'Cloud computer created',
      destroyed: 'Cloud computer destroyed',
      actionDone: 'Action submitted',
      saved: 'Connection settings saved',
      errUnauthorized: 'Rayrun rejected this token (401). Sign in with your account in connection settings, or paste a new API token.',
      errNetwork: 'Cannot reach Rayrun. Check the API address and your network.',
      errName: 'The name must be 1–64 characters.',
      errBaseUrl: 'The API address must be a full http(s) URL.',
      errNotFound: 'This cloud computer was not found.',
      errGeneric: 'The operation did not complete.',
      tokenStatus: 'Token source: {source}',
      notConfigured: 'No token configured',
      selectImage: 'Choose an image',
      passwordRequiresRunning: 'Start the machine before reading its desktop password.',
    }

    function english(ctx) {
      try {
        const locale = ctx.get?.('locale') ?? ctx.locale
        const id = locale?.getLocale?.()?.id
        return typeof id === 'string' && id.toLowerCase().startsWith('en')
      } catch {
        return false
      }
    }

    function useT(ctx) {
      const locale = ctx.get?.('locale') ?? ctx.locale
      const read = () => {
        try {
          return String(locale?.getLocale?.()?.id ?? 'zh')
        } catch {
          return 'zh'
        }
      }
      const [id, setId] = useState(read)
      useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => setId(read()))
      }, [locale])
      return id.toLowerCase().startsWith('en') ? EN : ZH
    }

    /* ------------------------------------------------------------------ */
    /* Small shared UI                                                    */
    /* ------------------------------------------------------------------ */

    function Modal({ title, subtitle, onClose, children, width }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose?.()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: 'rr-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose?.()
          },
        },
        h(
          'div',
          {
            className: 'rr-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            style: width ? { width } : undefined,
          },
          h(
            'div',
            { className: 'rr-modal-head' },
            h('div', null, h('h2', null, title), subtitle ? h('p', null, subtitle) : null),
            h('button', { type: 'button', className: 'rr-iconbtn', 'aria-label': 'Close', onClick: onClose }, I.close(16)),
          ),
          children,
        ),
      )
    }

    function ConnectionForm({ t, connection, onSaved }) {
      const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '')
      const [tab, setTab] = useState('account')
      const [username, setUsername] = useState('')
      const [password, setPassword] = useState('')
      const [token, setToken] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [methods, setMethods] = useState(null)
      const [methodsError, setMethodsError] = useState('')
      const [wechat, setWechat] = useState(null)
      const wechatRef = useRef(null)

      useEffect(() => {
        wechatRef.current = wechat
      }, [wechat])

      useEffect(
        () => () => {
          const flowId = wechatRef.current?.flowId
          if (flowId) void rpc('login.wechat.cancel', { flowId }).catch(() => {})
        },
        [],
      )

      useEffect(() => {
        setBaseUrl(connection?.baseUrl ?? '')
      }, [connection?.baseUrl])

      useEffect(() => {
        let cancelled = false
        const timer = setTimeout(() => {
          void (async () => {
            try {
              const data = await rpc('login.methods', { baseUrl })
              if (cancelled) return
              setMethods(data.methods)
              setMethodsError('')
            } catch (cause) {
              if (!cancelled) {
                setMethods(null)
                setMethodsError(errorText(cause, t))
              }
            }
          })()
        }, 250)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [baseUrl, t])

      useEffect(() => {
        if (!wechat?.flowId) return undefined
        if (wechat.status === 'authorized' || wechat.status === 'error') return undefined
        let cancelled = false
        const timer = setInterval(() => {
          void (async () => {
            try {
              const data = await rpc('login.wechat.status', { flowId: wechat.flowId })
              if (cancelled) return
              if (data.status === 'authorized') {
                setWechat(null)
                setNote(t.loginWechatOk)
                onSaved?.(data.connection)
              } else if (data.status === 'authorizing') {
                setWechat((prev) => (prev && prev.status !== 'authorizing' ? { ...prev, status: 'authorizing' } : prev))
              } else if (data.status !== 'pending') {
                setWechat(null)
                setError(data.error || t.loginWechatFailed)
              }
            } catch (cause) {
              if (!cancelled) {
                setWechat(null)
                setError(errorText(cause, t))
              }
            }
          })()
        }, 1000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [wechat?.flowId, wechat?.status, t, onSaved])

      const loginPassword = async () => {
        if (!username.trim() || !password) {
          setError(t.loginFieldsRequired)
          return
        }
        setBusy('password')
        setError('')
        setNote('')
        try {
          const data = await rpc('login.password', { baseUrl, username: username.trim(), password })
          setPassword('')
          setNote(t.loginPasswordOk)
          onSaved?.(data.connection)
        } catch (cause) {
          setError(errorText(cause, t))
        } finally {
          setBusy('')
        }
      }

      const startWechat = async () => {
        setBusy('wechat')
        setError('')
        setNote('')
        try {
          const data = await rpc('login.wechat.start', { baseUrl })
          if (data.mode === 'window') {
            setWechat({ flowId: data.flowId, status: 'pending' })
          } else {
            window.open(data.url, '_blank', 'noopener,noreferrer')
            setNote(t.loginWeChatBrowser)
            setTab('token')
          }
        } catch (cause) {
          setError(errorText(cause, t))
        } finally {
          setBusy('')
        }
      }

      const cancelWechat = async () => {
        const flowId = wechat?.flowId
        setWechat(null)
        setNote('')
        if (flowId) await rpc('login.wechat.cancel', { flowId }).catch(() => {})
      }

      const save = async () => {
        setBusy('save')
        setError('')
        setNote('')
        try {
          const data = await rpc('connection.save', { baseUrl, token })
          setToken('')
          setNote(t.saved)
          onSaved?.(data.connection)
        } catch (cause) {
          setError(errorText(cause, t))
        } finally {
          setBusy('')
        }
      }

      const test = async () => {
        setBusy('test')
        setError('')
        setNote('')
        try {
          const data = await rpc('connection.test', { baseUrl, token })
          setNote(tf(t, 'testOk', { agents: data.result.agents, machines: data.result.machines }))
        } catch (cause) {
          setError(errorText(cause, t))
        } finally {
          setBusy('')
        }
      }

      const logout = async () => {
        if (typeof window !== 'undefined' && !window.confirm(t.loginLogoutConfirm)) return
        setBusy('logout')
        setError('')
        setNote('')
        try {
          const data = await rpc('login.logout')
          setNote(t.loginLoggedOut)
          onSaved?.(data.connection)
        } catch (cause) {
          setError(errorText(cause, t))
        } finally {
          setBusy('')
        }
      }

      const source = connection?.tokenSource
        ? tf(t, 'tokenStatus', { source: t[`source_${connection.tokenSource}`] ?? connection.tokenSource })
        : t.notConfigured

      const tabButton = (id, label) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === id,
            className: tab === id ? 'on' : '',
            onClick: () => setTab(id),
          },
          label,
        )

      const accountPane = h(
        'div',
        { className: 'rr-login-pane' },
        h(
          'label',
          { className: 'rr-field' },
          h('span', { className: 'rr-label' }, t.loginUsername),
          h('input', {
            className: 'rr-input',
            value: username,
            placeholder: t.loginUsernamePlaceholder,
            spellCheck: false,
            autoComplete: 'username',
            onChange: (event) => setUsername(event.target.value),
          }),
        ),
        h(
          'label',
          { className: 'rr-field' },
          h('span', { className: 'rr-label' }, t.loginPassword),
          h('input', {
            className: 'rr-input',
            type: 'password',
            value: password,
            placeholder: t.loginPasswordPlaceholder,
            autoComplete: 'current-password',
            onChange: (event) => setPassword(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !busy) void loginPassword()
            },
          }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'rr-btn rr-btn-primary',
            style: { width: '100%' },
            disabled: Boolean(busy),
            onClick: () => void loginPassword(),
          },
          busy === 'password' ? t.loginBusy : t.loginAction,
        ),
        h('p', { className: 'rr-hint' }, t.loginAccountHint),
        methods?.wechat
          ? h(
              React.Fragment,
              null,
              h('div', { className: 'rr-login-or' }, h('span', null, t.loginOr)),
              wechat
                ? h(
                    'div',
                    { className: 'rr-login-flow' },
                    h('span', null, wechat.status === 'authorizing' ? t.loginWeChatAuthorizing : t.loginWeChatWindow),
                    h('button', { type: 'button', className: 'rr-btn', onClick: () => void cancelWechat() }, t.loginWeChatCancel),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'rr-btn rr-wechat',
                      disabled: Boolean(busy),
                      onClick: () => void startWechat(),
                    },
                    I.wechat(15),
                    t.loginWeChat,
                  ),
            )
          : methods
            ? h('p', { className: 'rr-hint' }, t.loginWeChatUnavailable)
            : null,
        methodsError ? h('p', { className: 'rr-hint' }, methodsError) : null,
      )

      const tokenPane = h(
        'div',
        { className: 'rr-login-pane' },
        h(
          'label',
          { className: 'rr-field' },
          h('span', { className: 'rr-label' }, t.tokenLabel),
          h('input', {
            className: 'rr-input',
            type: 'password',
            value: token,
            placeholder: connection?.configured ? t.tokenKeep : t.tokenPlaceholder,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setToken(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !busy) void save()
            },
          }),
        ),
        h('p', { className: 'rr-hint' }, t.loginTokenHint),
        h(
          'div',
          { className: 'rr-row', style: { justifyContent: 'flex-end' } },
          h(
            'button',
            { type: 'button', className: 'rr-btn', disabled: Boolean(busy), onClick: () => void test() },
            busy === 'test' ? t.testing : t.test,
          ),
          h(
            'button',
            { type: 'button', className: 'rr-btn rr-btn-primary', disabled: Boolean(busy), onClick: () => void save() },
            busy === 'save' ? t.saving : t.save,
          ),
        ),
      )

      return h(
        'div',
        { className: 'rr-modal-body' },
        h(
          'div',
          { className: 'rr-inline-status' },
          h('span', {
            className: 'rr-dot',
            style: {
              background: connection?.configured
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
            },
          }),
          h('span', null, source),
          h('span', { className: 'rr-badge' }, t[`source_${connection?.baseUrlSource}`] ?? connection?.baseUrlSource ?? ''),
          connection?.autoToken ? h('span', { className: 'rr-badge' }, t.loginAutoToken) : null,
        ),
        h(
          'label',
          { className: 'rr-field' },
          h('span', { className: 'rr-label' }, t.baseUrlLabel),
          h('input', {
            className: 'rr-input',
            value: baseUrl,
            placeholder: 'https://api.rayrunos.com/v1',
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setBaseUrl(event.target.value),
          }),
          h('span', { className: 'rr-hint' }, t.baseUrlHint),
        ),
        h(
          'div',
          { className: 'rr-login-tabs', role: 'tablist', 'aria-label': t.settingsTitle },
          tabButton('account', t.loginTabAccount),
          tabButton('token', t.loginTabToken),
        ),
        tab === 'account' ? accountPane : tokenPane,
        error ? h('p', { className: 'rr-error' }, I.alert(15), error) : null,
        note ? h('p', { className: 'rr-ok' }, I.check(15), note) : null,
        connection?.configured && (connection.tokenSource === 'credentials' || connection.autoToken)
          ? h(
              'div',
              { className: 'rr-login-foot' },
              h('button', { type: 'button', className: 'rr-btn', disabled: Boolean(busy), onClick: () => void logout() }, t.loginLogout),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Composer task-target toggle                                        */
    /* ------------------------------------------------------------------ */

    function TaskTargetControl({ ctx, sessionId }) {
      const t = useT(ctx)
      const [target, setTarget] = useState('local')
      const [error, setError] = useState('')
      const storageKey = sessionId ? `rayrun:task-target:${sessionId}` : ''

      const readStored = () => {
        try {
          const value = localStorage.getItem(storageKey)
          return value === 'cloud' || value === 'local' ? value : null
        } catch {
          return null
        }
      }

      const writeStored = (value) => {
        try {
          if (storageKey) localStorage.setItem(storageKey, value)
        } catch {
          // storage may be unavailable; the Host copy is authoritative for this tab
        }
      }

      useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        const stored = readStored()
        void (async () => {
          try {
            const data = await rpc('task.target.get', { sessionId })
            if (cancelled) return
            if (stored && stored !== data.target) {
              try {
                const next = await rpc('task.target.set', { sessionId, target: stored })
                if (!cancelled) setTarget(next.target)
              } catch (cause) {
                if (!cancelled) {
                  setTarget(data.target)
                  setError(errorText(cause, t))
                }
              }
            } else {
              setTarget(data.target)
            }
          } catch (cause) {
            if (!cancelled) setError(errorText(cause, t))
          }
        })()
        return () => {
          cancelled = true
        }
      }, [sessionId, storageKey, t])

      const choose = async (next) => {
        if (!sessionId || next === target) return
        const previous = target
        setTarget(next)
        setError('')
        writeStored(next)
        try {
          await rpc('task.target.set', { sessionId, target: next })
        } catch (cause) {
          setTarget(previous)
          writeStored(previous)
          setError(errorText(cause, t))
        }
      }

      if (!sessionId) return null

      return h(
        React.Fragment,
        null,
        h('style', { key: 'rayrun-target-css' }, TARGET_CSS),
        h(
          'div',
          {
            className: 'rr-target',
            title: error ? `${t.taskTargetHint} · ${error}` : t.taskTargetHint,
          },
          h('span', { className: 'rr-target-label' }, t.taskTarget),
          h(
            'div',
            { className: 'rr-target-seg', role: 'group', 'aria-label': t.taskTarget },
            h(
              'button',
              {
                type: 'button',
                className: target === 'cloud' ? 'on' : '',
                'aria-pressed': target === 'cloud',
                title: t.taskTargetHint,
                onClick: () => void choose('cloud'),
              },
              I.cloud(13),
              h('span', null, t.taskTargetCloud),
            ),
            h(
              'button',
              {
                type: 'button',
                className: target === 'local' ? 'on' : '',
                'aria-pressed': target === 'local',
                title: t.taskTargetHint,
                onClick: () => void choose('local'),
              },
              I.laptop(13),
              h('span', null, t.taskTargetLocal),
            ),
          ),
          error ? h('span', { className: 'rr-target-error', title: error, 'aria-label': error }, '!') : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Create / rename / destroy / password dialogs                       */
    /* ------------------------------------------------------------------ */

    function CreateDialog({ t, agents, defaults, onClose, onCreate }) {
      const desktopAgents = useMemo(() => (agents || []).filter((item) => item.supports_desktop), [agents])
      const [name, setName] = useState(() => `cloud-${Math.random().toString(36).slice(2, 6)}`)
      const [agent, setAgent] = useState(() => {
        const preferred = desktopAgents.find((item) => item.ref === defaults?.agent)
        return (preferred ?? desktopAgents[0])?.ref ?? ''
      })
      const [cpu, setCpu] = useState(Number(defaults?.cpu_cores) || 2)
      const [memory, setMemory] = useState(2048)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const submit = async () => {
        const trimmed = name.trim()
        if (!trimmed || trimmed.length > 64) {
          setError(t.errName)
          return
        }
        if (!agent) {
          setError(t.selectImage)
          return
        }
        setBusy(true)
        setError('')
        try {
          await onCreate({ name: trimmed, agent, cpu_cores: cpu, memory_mb: Math.max(2048, memory), remote_desktop: true })
        } catch (cause) {
          setError(errorText(cause, t))
          setBusy(false)
        }
      }

      return h(
        Modal,
        { title: t.createTitle, subtitle: t.createHint, onClose: onClose },
        h(
          'div',
          { className: 'rr-modal-body' },
          h(
            'label',
            { className: 'rr-field' },
            h('span', { className: 'rr-label' }, t.nameLabel),
            h('input', {
              className: 'rr-input',
              value: name,
              placeholder: t.namePlaceholder,
              maxLength: 64,
              autoFocus: true,
              spellCheck: false,
              onChange: (event) => setName(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'rr-field' },
            h('span', { className: 'rr-label' }, t.imageLabel),
            h(
              'select',
              {
                className: 'rr-select',
                value: agent,
                onChange: (event) => setAgent(event.target.value),
              },
              desktopAgents.length === 0 ? h('option', { value: '' }, t.selectImage) : null,
              desktopAgents.map((item) =>
                h('option', { key: item.ref, value: item.ref }, item.description ? `${item.ref} — ${item.description}` : item.ref),
              ),
            ),
            h('span', { className: 'rr-hint' }, t.imageHint),
          ),
          h(
            'div',
            { className: 'rr-field' },
            h('span', { className: 'rr-label' }, `${t.cpuLabel} · ${t.specLabel}`),
            h(
              'div',
              { className: 'rr-seg' },
              [1, 2, 4, 8].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: cpu === value ? 'on' : '',
                    onClick: () => setCpu(value),
                  },
                  `${value} vCPU`,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'rr-field' },
            h('span', { className: 'rr-label' }, t.memoryLabel),
            h(
              'div',
              { className: 'rr-seg' },
              [2048, 4096, 8192, 16384].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: memory === value ? 'on' : '',
                    onClick: () => setMemory(value),
                  },
                  `${value / 1024} GB`,
                ),
              ),
            ),
          ),
          error ? h('p', { className: 'rr-error' }, I.alert(15), error) : null,
          h(
            'div',
            { className: 'rr-modal-actions' },
            h('button', { type: 'button', className: 'rr-btn', disabled: busy, onClick: onClose }, t.cancel),
            h(
              'button',
              { type: 'button', className: 'rr-btn rr-btn-primary', disabled: busy || !desktopAgents.length, onClick: () => void submit() },
              busy ? t.creating : t.create,
            ),
          ),
        ),
      )
    }

    function RenameDialog({ t, machine, onClose, onRename }) {
      const [name, setName] = useState(machine?.name ?? '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const submit = async () => {
        if (!name.trim()) {
          setError(t.errName)
          return
        }
        setBusy(true)
        setError('')
        try {
          await onRename(name.trim())
          onClose()
        } catch (cause) {
          setError(errorText(cause, t))
          setBusy(false)
        }
      }
      return h(
        Modal,
        { title: t.renameTitle, onClose },
        h(
          'div',
          { className: 'rr-modal-body' },
          h(
            'label',
            { className: 'rr-field' },
            h('span', { className: 'rr-label' }, t.renameLabel),
            h('input', {
              className: 'rr-input',
              value: name,
              maxLength: 64,
              autoFocus: true,
              onChange: (event) => setName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !busy) void submit()
              },
            }),
          ),
          error ? h('p', { className: 'rr-error' }, I.alert(15), error) : null,
          h(
            'div',
            { className: 'rr-modal-actions' },
            h('button', { type: 'button', className: 'rr-btn', disabled: busy, onClick: onClose }, t.cancel),
            h('button', { type: 'button', className: 'rr-btn rr-btn-primary', disabled: busy, onClick: () => void submit() }, t.save),
          ),
        ),
      )
    }

    function DestroyDialog({ t, machine, onClose, onDestroy }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          await onDestroy()
          onClose()
        } catch (cause) {
          setError(errorText(cause, t))
          setBusy(false)
        }
      }
      return h(
        Modal,
        { title: t.destroyTitle, onClose },
        h(
          'div',
          { className: 'rr-modal-body' },
          h('p', { className: 'rr-note' }, tf(t, 'destroyBody', { name: machine?.name ?? machine?.id ?? '' })),
          error ? h('p', { className: 'rr-error' }, I.alert(15), error) : null,
          h(
            'div',
            { className: 'rr-modal-actions' },
            h('button', { type: 'button', className: 'rr-btn', disabled: busy, onClick: onClose }, t.cancel),
            h(
              'button',
              { type: 'button', className: 'rr-btn rr-btn-danger', disabled: busy, onClick: () => void submit() },
              busy ? t.destroying : t.destroyConfirm,
            ),
          ),
        ),
      )
    }

    function PasswordDialog({ t, machine, onClose }) {
      const [state, setState] = useState({ loading: true, text: '', error: '', copied: false })
      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const data = await rpc('machine.password', { id: machine.id })
            if (cancelled) return
            const result = data.result ?? {}
            const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
            setState({ loading: false, text: text || t.passwordEmpty, error: '', copied: false })
          } catch (cause) {
            if (!cancelled) setState({ loading: false, text: '', error: errorText(cause, t), copied: false })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [machine.id, t])
      return h(
        Modal,
        { title: t.passwordTitle, subtitle: t.passwordHint, onClose },
        h(
          'div',
          { className: 'rr-modal-body' },
          state.loading
            ? h('p', { className: 'rr-note' }, t.passwordLoading)
            : state.error
              ? h('p', { className: 'rr-error' }, I.alert(15), state.error)
              : h('pre', { className: 'rr-code' }, state.text),
          h(
            'div',
            { className: 'rr-modal-actions' },
            !state.loading && !state.error
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'rr-btn',
                    onClick: async () => {
                      const ok = await copyText(state.text)
                      if (ok) setState((prev) => ({ ...prev, copied: true }))
                    },
                  },
                  state.copied ? t.copied : t.copy,
                )
              : null,
            h('button', { type: 'button', className: 'rr-btn rr-btn-primary', onClick: onClose }, t.close),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Desktop view                                                       */
    /* ------------------------------------------------------------------ */

    function DesktopView({ t, machine, busy, onBack, onAction, onRefresh, onPassword }) {
      const [frameKey, setFrameKey] = useState(0)
      const [loaded, setLoaded] = useState(false)
      const stageRef = useRef(null)
      const status = statusMeta(machine.status, t)
      const url = machine.desktop_url

      useEffect(() => {
        setLoaded(false)
        if (!url) return undefined
        const timer = setTimeout(() => setLoaded(true), 9000)
        return () => clearTimeout(timer)
      }, [url, frameKey])

      const reason = (() => {
        switch (machine.desktop_reason) {
          case 'not-enabled':
            return t.noDesktopNotEnabled
          case 'not-published':
            return t.noDesktopNotPublished
          case 'no-ingress':
            return t.noDesktopNoIngress
          default:
            return t.noDesktopUnknown
        }
      })()

      const fullscreen = () => {
        const node = stageRef.current
        if (!node) return
        try {
          if (document.fullscreenElement) void document.exitFullscreen()
          else void node.requestFullscreen?.()
        } catch {
          // the browser may refuse fullscreen outside a user gesture
        }
      }

      return h(
        'div',
        { className: 'rr-desktop' },
        h(
          'div',
          { className: 'rr-dbar' },
          h('button', { type: 'button', className: 'rr-iconbtn', title: t.desktopBack, 'aria-label': t.desktopBack, onClick: onBack }, I.back(17)),
          h(
            'div',
            { className: 'rr-dtitle' },
            h('div', { className: 'rr-dname' }, machine.name || machine.id),
            h('div', { className: 'rr-dstatus' }, h('span', { className: 'rr-dot', style: { background: status.color } }), status.label, '·', machine.agent),
          ),
          h(
            'div',
            { className: 'rr-dactions' },
            machine.remote_desktop
              ? h('button', { type: 'button', className: 'rr-iconbtn', title: t.desktopPassword, 'aria-label': t.desktopPassword, onClick: onPassword }, I.key(17))
              : null,
            url ? h('button', { type: 'button', className: 'rr-iconbtn', title: t.desktopReload, 'aria-label': t.desktopReload, onClick: async () => { await onRefresh?.(); setFrameKey((value) => value + 1) } }, I.refresh(17)) : null,
            url ? h('button', { type: 'button', className: 'rr-iconbtn', title: t.desktopExternal, 'aria-label': t.desktopExternal, onClick: () => window.open(url, '_blank', 'noopener,noreferrer') }, I.external(17)) : null,
            url ? h('button', { type: 'button', className: 'rr-iconbtn', title: t.desktopFullscreen, 'aria-label': t.desktopFullscreen, onClick: fullscreen }, I.expand(17)) : null,
            machine.status === 'Running'
              ? h('button', { type: 'button', className: 'rr-iconbtn', title: t.shutdown, 'aria-label': t.shutdown, disabled: busy, onClick: () => onAction('stop') }, I.power(17))
              : h('button', { type: 'button', className: 'rr-iconbtn', title: t.powerOn, 'aria-label': t.powerOn, disabled: busy, onClick: () => onAction(machine.status === 'Paused' ? 'resume' : 'start') }, I.play(17)),
          ),
        ),
        h(
          'div',
          { className: 'rr-stage', ref: stageRef },
          url
            ? h('iframe', {
                key: frameKey,
                className: 'rr-frame',
                src: url,
                title: machine.name || 'Rayrun desktop',
                allow: 'clipboard-read; clipboard-write; fullscreen',
                referrerPolicy: 'no-referrer',
                onLoad: () => setLoaded(true),
              })
            : h(
                'div',
                { className: 'rr-nodesktop' },
                h('div', { className: 'rr-nodesktop-art' }, I.monitor(40)),
                h('h2', null, t.noDesktopTitle),
                h('p', null, reason),
                h(
                  'div',
                  { className: 'rr-spec' },
                  h('span', null, tf(t, 'spec', { cpu: machine.cpu_cores, mem: Math.round(machine.memory_mb / 1024) })),
                  machine.ip ? h('span', null, machine.ip) : null,
                  machine.desktop_port ? h('span', null, `:${machine.desktop_port}`) : null,
                ),
                h(
                  'div',
                  { className: 'rr-row', style: { justifyContent: 'center' } },
                  h('button', { type: 'button', className: 'rr-btn', onClick: onRefresh }, t.retry),
                  machine.remote_desktop
                    ? h('button', { type: 'button', className: 'rr-btn', onClick: onPassword }, t.desktopPassword)
                    : null,
                ),
              ),
          url && !loaded
            ? h(
                'div',
                { className: 'rr-stage-mask' },
                h('div', { className: 'rr-spin' }),
                h('span', null, t.desktopNotReady),
              )
            : null,
        ),
        h(
          'div',
          { className: 'rr-dfoot' },
          h('span', null, t.desktopFoot),
          machine.remote_desktop ? h('button', { type: 'button', className: 'rr-btn', style: { height: 24, fontSize: 11 }, onClick: onPassword }, t.desktopPassword) : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Main panel                                                         */
    /* ------------------------------------------------------------------ */

    function RayrunPanel({ ctx }) {
      const t = useT(ctx)
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [view, setView] = useState({ kind: 'list' })
      const [modal, setModal] = useState(null)
      const [notice, setNotice] = useState('')
      const [busyId, setBusyId] = useState('')
      const [menuFor, setMenuFor] = useState('')

      const updateMachine = useCallback((machine) => {
        setData((prev) => {
          if (!prev) return prev
          const exists = prev.machines.some((item) => item.id === machine.id)
          return {
            ...prev,
            machines: exists ? prev.machines.map((item) => (item.id === machine.id ? machine : item)) : [machine, ...prev.machines],
          }
        })
      }, [])

      const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true)
        try {
          const next = await rpcGet('overview')
          setData(next)
          setError(null)
        } catch (cause) {
          setError(cause)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(''), 4200)
        return () => clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (!menuFor) return undefined
        const close = () => setMenuFor('')
        window.addEventListener('click', close)
        return () => window.removeEventListener('click', close)
      }, [menuFor])

      const connection = data?.connection
      const machines = data?.machines ?? []

      const openCreate = () => {
        if (!connection?.configured) {
          setModal({ kind: 'settings' })
          return
        }
        setModal({ kind: 'create' })
      }

      const openDesktop = (machine) => setView({ kind: 'desktop', id: machine.id })

      const prepareDesktop = async (machine) => {
        if (!machine?.remote_desktop) return
        try {
          await rpc('machine.desktopRepair', { id: machine.id })
        } catch (cause) {
          setNotice(errorText(cause, t))
        }
      }

      const connectMachine = async (machine) => {
        if (machine.status === 'Running') {
          setBusyId(machine.id)
          try {
            await prepareDesktop(machine)
          } finally {
            setBusyId('')
          }
          openDesktop(machine)
          return
        }
        setBusyId(machine.id)
        try {
          const action = machine.status === 'Paused' ? 'resume' : 'start'
          const first = await rpc('machine.action', { id: machine.id, verb: action })
          if (first.machine) updateMachine(first.machine)
          if (action === 'start' || action === 'resume') {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              await sleep(1500)
              const next = await rpc('machine.get', { id: machine.id })
              updateMachine(next.machine)
              if (next.machine.status === 'Running') break
            }
          }
          await prepareDesktop({ ...machine, status: 'Running' })
          openDesktop({ ...machine, status: 'Running' })
        } catch (cause) {
          setNotice(errorText(cause, t))
        } finally {
          setBusyId('')
        }
      }

      const runAction = async (machine, action, extra = {}) => {
        setBusyId(machine.id)
        try {
          const result = await rpc('machine.action', { id: machine.id, verb: action, ...extra })
          if (action === 'destroy') {
            setData((prev) => (prev ? { ...prev, machines: prev.machines.filter((item) => item.id !== machine.id) } : prev))
            setView({ kind: 'list' })
            setNotice(t.destroyed)
          } else {
            if (result.machine) updateMachine(result.machine)
            else {
              const next = await rpc('machine.get', { id: machine.id }).catch(() => null)
              if (next?.machine) updateMachine(next.machine)
            }
            setNotice(t.actionDone)
          }
        } catch (cause) {
          setNotice(errorText(cause, t))
          throw cause
        } finally {
          setBusyId('')
        }
      }

      const refreshOne = async (machine) => {
        try {
          await prepareDesktop(machine)
          const next = await rpc('machine.get', { id: machine.id })
          updateMachine(next.machine)
          setNotice('')
          return next.machine
        } catch (cause) {
          setNotice(errorText(cause, t))
          return machine
        }
      }

      const createMachine = async (form) => {
        const result = await rpc('machine.create', form)
        await prepareDesktop(result.machine)
        setData((prev) => (prev ? { ...prev, machines: [result.machine, ...prev.machines] } : prev))
        setModal(null)
        setNotice(t.created)
        setView({ kind: 'desktop', id: result.machine.id })
        void load(true)
      }

      const renderCard = (machine) => {
        const busy = busyId === machine.id
        const status = statusMeta(machine.status, t)
        const isRunning = machine.status === 'Running'
        const primary = isRunning ? t.connect : machine.status === 'Paused' ? t.resume : t.powerOn
        return h(
          'article',
          { className: 'rr-card', key: machine.id },
          h(
            'div',
            { className: 'rr-cover' },
            h('div', { className: 'rr-cover-glow' }),
            h('div', { className: 'rr-cover-art' }, machine.remote_desktop ? I.monitor(46) : I.terminal(42)),
            h('span', { className: 'rr-pill' }, h('span', { className: 'rr-dot', style: { background: status.color } }), status.label),
            h('span', { className: 'rr-chip' }, machine.remote_desktop ? t.cardDesktop : t.cardSandbox),
            h('span', { className: 'rr-cover-brand' }, 'rayrun'),
          ),
          h(
            'div',
            { className: 'rr-card-body' },
            h(
              'div',
              { className: 'rr-card-name' },
              h(
                'div',
                { style: { minWidth: 0, flex: 1 } },
                h('h3', { className: 'rr-name', title: machine.name || machine.id }, machine.name || machine.id.slice(0, 13)),
                h('p', { className: 'rr-image' }, agentDescription(data?.agents, machine.agent) || machine.agent),
              ),
            ),
            h(
              'div',
              { className: 'rr-meta' },
              h('span', null, tf(t, 'spec', { cpu: machine.cpu_cores, mem: Math.round(machine.memory_mb / 1024) })),
              machine.ip ? h('span', null, machine.ip) : null,
              machine.usage?.vm_hours ? h('span', null, tf(t, 'usageHours', { hours: machine.usage.vm_hours.toFixed(1) })) : null,
            ),
            h(
              'div',
              { className: 'rr-card-foot' },
              h(
                'button',
                { type: 'button', className: 'rr-btn rr-btn-primary rr-grow', disabled: busy, onClick: () => void connectMachine(machine) },
                busy ? t.connectStarting : primary,
              ),
              isRunning
                ? h(
                    'button',
                    { type: 'button', className: 'rr-iconbtn', title: t.shutdown, 'aria-label': t.shutdown, disabled: busy, onClick: () => void runAction(machine, 'stop').catch(() => {}) },
                    I.power(16),
                  )
                : h(
                    'button',
                    { type: 'button', className: 'rr-iconbtn', title: primary, 'aria-label': primary, disabled: busy, onClick: () => void connectMachine(machine) },
                    I.play(16),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'rr-iconbtn',
                  title: t.more,
                  'aria-label': t.more,
                  onClick: (event) => {
                    event.stopPropagation()
                    setMenuFor((value) => (value === machine.id ? '' : machine.id))
                  },
                },
                I.more(16),
              ),
              menuFor === machine.id
                ? h(
                    'div',
                    { className: 'rr-menu', onClick: (event) => event.stopPropagation() },
                    machine.desktop_url
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => {
                              setMenuFor('')
                              window.open(machine.desktop_url, '_blank', 'noopener,noreferrer')
                            },
                          },
                          I.external(15),
                          t.openExternal,
                        )
                      : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          setMenuFor('')
                          setModal({ kind: 'rename', machine })
                        },
                      },
                      I.edit(15),
                      t.rename,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'danger',
                        onClick: () => {
                          setMenuFor('')
                          setModal({ kind: 'destroy', machine })
                        },
                      },
                      I.trash(15),
                      t.destroy,
                    ),
                  )
                : null,
            ),
          ),
        )
      }

      const renderList = () => {
        if (loading && !data) {
          return h(
            'div',
            { className: 'rr-grid' },
            [0, 1, 2].map((key) => h('div', { key, className: 'rr-skeleton' })),
          )
        }

        if (error && !data) {
          return h(
            'div',
            { className: 'rr-empty' },
            h('div', { className: 'rr-empty-art' }, I.alert(38)),
            h('h2', null, t.errorTitle),
            h('p', null, errorText(error, t)),
            h(
              'div',
              { className: 'rr-row', style: { justifyContent: 'center' } },
              h('button', { type: 'button', className: 'rr-btn', onClick: () => void load() }, t.retry),
              h('button', { type: 'button', className: 'rr-btn rr-btn-primary', onClick: () => setModal({ kind: 'settings' }) }, t.openSettings),
            ),
          )
        }

        if (!connection?.configured) {
          return h(
            'div',
            { className: 'rr-setup' },
            h(
              'div',
              { className: 'rr-setup-card' },
              h(
                'div',
                { className: 'rr-setup-head' },
                h('div', { className: 'rr-setup-icon' }, I.monitor(22)),
                h('div', null, h('h2', null, t.setupTitle), h('p', null, t.setupBody)),
              ),
              h(ConnectionForm, {
                t,
                connection,
                onSaved: () => {
                  setNotice(t.saved)
                  void load(true)
                },
              }),
            ),
          )
        }

        if (machines.length === 0) {
          return h(
            'div',
            { className: 'rr-empty' },
            h('div', { className: 'rr-empty-art' }, I.monitor(38)),
            h('h2', null, t.emptyTitle),
            h('p', null, t.emptyBody),
            h('button', { type: 'button', className: 'rr-btn rr-btn-primary', onClick: openCreate }, I.plus(16), t.createFirst),
          )
        }

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'rr-summary' },
            h('div', { className: 'rr-stat' }, h('span', null, t.balance), h('b', null, formatMoney(data?.balance))),
            h('div', { className: 'rr-stat' }, h('span', null, t.hours), h('b', null, formatHours(data?.usage))),
            h('div', { className: 'rr-stat' }, h('span', null, t.running), h('b', null, String(machines.filter((item) => item.status === 'Running').length))),
            h(
              'div',
              { className: 'rr-summary-right' },
              h('span', { className: 'rr-dot' }),
              h('span', null, t.connectedTo),
              h('em', null, hostOf(connection.baseUrl)),
            ),
          ),
          error
            ? h(
                'div',
                { className: 'rr-banner' },
                I.alert(16),
                h('span', null, errorText(error, t)),
                h('button', { type: 'button', className: 'rr-btn', onClick: () => void load() }, t.retry),
              )
            : null,
          h('div', { className: 'rr-grid' }, machines.map(renderCard)),
        )
      }

      const machine = view.kind === 'desktop' ? machines.find((item) => item.id === view.id) : undefined

      return h(
        React.Fragment,
        null,
        h('style', { key: 'rayrun-css' }, CSS),
        view.kind === 'desktop'
          ? machine
            ? h(DesktopView, {
                t,
                machine,
                busy: busyId === machine.id,
                onBack: () => setView({ kind: 'list' }),
                onAction: (action) => void runAction(machine, action).catch(() => {}),
                onRefresh: () => refreshOne(machine),
                onPassword: () => setModal({ kind: 'password', machine }),
              })
            : h(
                'div',
                { className: 'rr-empty' },
                h('div', { className: 'rr-empty-art' }, I.alert(38)),
                h('h2', null, t.errNotFound),
                h('button', { type: 'button', className: 'rr-btn', onClick: () => setView({ kind: 'list' }) }, t.desktopBack),
              )
          : h(
              'div',
              { className: 'rr-root' },
              h(
                'header',
                { className: 'rr-header' },
                h('div', null, h('h1', { className: 'rr-title' }, t.title), h('p', { className: 'rr-sub' }, t.subtitle)),
                h(
                  'div',
                  { className: 'rr-actions' },
                  h('button', { type: 'button', className: 'rr-iconbtn', title: t.refresh, 'aria-label': t.refresh, onClick: () => void load(true) }, I.refresh(17)),
                  h('button', { type: 'button', className: 'rr-iconbtn', title: t.settings, 'aria-label': t.settings, onClick: () => setModal({ kind: 'settings' }) }, I.settings(17)),
                  h(
                    'button',
                    { type: 'button', className: 'rr-btn rr-btn-primary', disabled: !connection?.configured, onClick: openCreate },
                    I.plus(16),
                    t.newMachine,
                  ),
                ),
              ),
              h('div', { className: 'rr-scroll' }, h('div', { className: 'rr-container' }, renderList())),
            ),
        modal?.kind === 'create'
          ? h(CreateDialog, {
              t,
              agents: data?.agents ?? [],
              defaults: data?.defaults,
              onClose: () => setModal(null),
              onCreate: createMachine,
            })
          : null,
        modal?.kind === 'settings'
          ? h(
              Modal,
              { title: t.settingsTitle, onClose: () => setModal(null) },
              h(ConnectionForm, {
                t,
                connection,
                onSaved: () => {
                  setModal(null)
                  setNotice(t.saved)
                  void load(true)
                },
              }),
            )
          : null,
        modal?.kind === 'rename'
          ? h(RenameDialog, {
              t,
              machine: modal.machine,
              onClose: () => setModal(null),
              onRename: (name) => runAction(modal.machine, 'rename', { name }),
            })
          : null,
        modal?.kind === 'destroy'
          ? h(DestroyDialog, {
              t,
              machine: modal.machine,
              onClose: () => setModal(null),
              onDestroy: () => runAction(modal.machine, 'destroy').then(() => setModal(null)),
            })
          : null,
        modal?.kind === 'password'
          ? h(PasswordDialog, { t, machine: modal.machine, onClose: () => setModal(null) })
          : null,
        notice ? h('div', { className: 'rr-toast', role: 'status' }, notice) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Settings section                                                   */
    /* ------------------------------------------------------------------ */

    function SettingsSection({ ctx }) {
      const t = useT(ctx)
      const [connection, setConnection] = useState(null)
      const [error, setError] = useState('')
      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const data = await rpcGet('status')
            if (!cancelled) setConnection(data.connection)
          } catch (cause) {
            if (!cancelled) setError(errorText(cause, t))
          }
        })()
        return () => {
          cancelled = true
        }
      }, [t])
      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'section',
          { className: 'rr-settings' },
          h('h2', null, t.settingsTitle),
          h('p', null, t.setupBody),
          error ? h('p', { className: 'rr-error' }, I.alert(15), error) : null,
          connection
            ? h('div', { className: 'rr-panel' }, h(ConnectionForm, { t, connection, onSaved: (next) => setConnection(next) }))
            : h('p', { className: 'rr-note' }, t.loading),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar icon and registration                                      */
    /* ------------------------------------------------------------------ */

    function PanelIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 20
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.65,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 2.6, y: 4.2, width: 18.8, height: 12.6, rx: 2.2 }),
        h('path', { d: 'M9 20.5h6M12 16.8v3.7' }),
        h('path', { d: 'M7.5 13.2a2.8 2.8 0 0 1 .55-3.05 3.55 3.55 0 0 1 5.95.2 2.55 2.55 0 0 1 1.2 4.8' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const panelLabel = () => (english(ctx) ? 'Cloud Computer' : '云电脑')
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: panelLabel,
            },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            (props) => h(RayrunPanel, { ctx, ...props }),
          ),
        )
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'rayrun-task-target',
              order: 10,
              label: () => (english(ctx) ? 'Task target' : '工作任务'),
            },
            (props) => h(TaskTargetControl, { ctx, sessionId: props.sessionId }),
          ),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SETTINGS_ID,
              order: 30,
              label: () => (english(ctx) ? 'Rayrun Cloud Computer' : 'Rayrun 云电脑'),
            },
            (props) => h(SettingsSection, { ctx, ...props }),
          ),
        )
      },
    }
  },
})
