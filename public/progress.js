// Shared "data-run progress" banner. Each page includes this script and places
// a container: <section data-progress-domain="pools"></section>. The script
// pulls /api/progress?domain=<domain> and renders the covered window, row
// counts, freshness, and any "missing data" warnings so you can tell at a
// glance how far that pipeline has run and what is still absent.
(function () {
  'use strict'

  const el = document.querySelector('[data-progress-domain]')
  if (!el) return
  const domain = el.getAttribute('data-progress-domain')

  injectStyles()

  function injectStyles() {
    if (document.getElementById('progress-styles')) return
    const css = `
    .progress-card { margin-bottom: 16px; }
    .progress-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    .progress-title { font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; }
    .progress-fresh { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); }
    .progress-fresh .dot { width:8px; height:8px; border-radius:50%; background:var(--text-3); }
    .progress-fresh.ok .dot { background:var(--success); }
    .progress-fresh.lag .dot { background:var(--accent); }
    .progress-fresh.stale .dot { background:var(--danger); }
    .progress-cover { font-size:12px; color:var(--text-2); margin-top:8px; font-family:var(--mono); }
    .progress-cover b { color:var(--text); font-weight:500; }
    .progress-chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .progress-chip { display:flex; flex-direction:column; gap:2px; padding:8px 12px; border:1px solid var(--border);
      border-radius:var(--radius-sm); background:var(--surface); min-width:96px; }
    .progress-chip .k { font-size:11px; color:var(--text-3); }
    .progress-chip .v { font-size:14px; font-weight:600; color:var(--text); font-family:var(--mono); }
    .progress-chip.warn { border-color:var(--danger); }
    .progress-chip.warn .v { color:var(--danger); }
    .progress-note { margin-top:10px; font-size:12px; color:var(--accent); }
    `
    const style = document.createElement('style')
    style.id = 'progress-styles'
    style.textContent = css
    document.head.appendChild(style)
  }

  function fmtNum(v) {
    if (v == null) return '—'
    if (typeof v !== 'number') return String(v)
    return v.toLocaleString('en-US')
  }

  function fmtDate(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d)) return String(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function fmtAge(iso) {
    if (!iso) return { text: '无数据', cls: 'stale' }
    const ms = Date.now() - new Date(iso).getTime()
    if (!isFinite(ms)) return { text: '无数据', cls: 'stale' }
    const h = ms / 3600000
    let text
    if (h < 1) text = `${Math.max(1, Math.round(ms / 60000))} 分钟前`
    else if (h < 48) text = `${Math.round(h)} 小时前`
    else text = `${Math.round(h / 24)} 天前`
    const cls = h < 3 ? 'ok' : h < 24 ? 'lag' : 'stale'
    return { text, cls, h }
  }

  function render(d) {
    if (!d) {
      el.innerHTML = '<div class="card progress-card"><div class="progress-title">数据进度不可用</div></div>'
      return
    }
    const age = fmtAge(d.latest)
    // batch (non-live) pipelines shouldn't be flagged red for being "stale" —
    // they only run on demand. Show the age neutrally.
    const freshCls = d.live ? age.cls : ''
    const freshLabel = d.live ? '最新' : '更新于'

    const chips = (d.metrics || []).map(m => `
      <div class="progress-chip${m.warn ? ' warn' : ''}">
        <span class="k">${escapeHtml(m.label)}</span>
        <span class="v">${typeof m.value === 'number' ? fmtNum(m.value) : escapeHtml(String(m.value))}</span>
      </div>`).join('')

    const cover = (d.earliest || d.latest)
      ? `覆盖 <b>${fmtDate(d.earliest)}</b> → <b>${fmtDate(d.latest)}</b>${d.rows != null ? ` · 共 <b>${fmtNum(d.rows)}</b> 行` : ''}`
      : (d.rows != null ? `共 <b>${fmtNum(d.rows)}</b> 行` : '暂无数据')

    el.innerHTML = `
      <div class="card progress-card">
        <div class="progress-head">
          <span class="progress-title">📊 数据进度 · ${escapeHtml(d.title || '')}</span>
          <span class="progress-fresh ${freshCls}"><span class="dot"></span>${freshLabel} ${escapeHtml(age.text)}${d.latest ? ` (${fmtDate(d.latest)})` : ''}</span>
        </div>
        <div class="progress-cover">${cover}</div>
        ${chips ? `<div class="progress-chips">${chips}</div>` : ''}
        ${d.note ? `<div class="progress-note">⚠ ${escapeHtml(d.note)}</div>` : ''}
      </div>`
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  async function load() {
    try {
      const res = await fetch(`/api/progress?domain=${encodeURIComponent(domain)}`)
      const json = await res.json()
      render(json.progress && json.progress[domain])
    } catch (err) {
      el.innerHTML = `<div class="card progress-card"><div class="progress-title">数据进度加载失败: ${escapeHtml(err.message)}</div></div>`
    }
  }

  load()
  setInterval(load, 60000)
})()
