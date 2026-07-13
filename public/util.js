'use strict'

// Shared dashboard helpers, loaded before each page's own script so every
// page renders addresses the same way: shortened, with a copy button. The
// delegated click handler makes any .copy-btn work without per-page wiring.

function escAttr(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch])
}

function shortAddr(a) {
  if (!a) return '—'
  const s = String(a)
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

function copyBtn(text) {
  if (!text) return ''
  const safe = escAttr(text)
  return `<button class="copy-btn" data-copy="${safe}" title="Copy ${safe}">⧉</button>`
}

// Shortened address + copy button, the default way to show any address/hash.
function addrCell(value) {
  if (!value) return '—'
  return `${shortAddr(value)}${copyBtn(value)}`
}

// Copy-to-clipboard for any .copy-btn (delegated, works on all pages).
document.addEventListener('click', async e => {
  const b = e.target.closest('.copy-btn')
  if (!b) return
  e.stopPropagation()
  e.preventDefault()
  try {
    await navigator.clipboard.writeText(b.dataset.copy)
    const o = b.textContent
    b.textContent = '✓'; b.classList.add('copied')
    setTimeout(() => { b.textContent = o; b.classList.remove('copied') }, 1000)
  } catch (err) { console.error('copy failed', err) }
})
