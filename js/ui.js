// Tiny DOM helpers. Everything is built with textContent, never innerHTML,
// so team names or notes can never inject markup.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') deferredValue = v;           // set after <option>s exist
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'open') el[k] = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = kid => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

// Replace a parent's children using the same rules as h() (arrays, null and false are fine).
export function setChildren(parent, ...kids) {
  const tmp = h('div', {}, ...kids);
  parent.replaceChildren(...tmp.childNodes);
}

export function toast(msg, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

// One loading look everywhere: a small ring that only appears if loading takes a moment (no flash for quick pages).
export const spinner = (msg = 'Loading…') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'ring', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, msg));

// Wrap an async click handler: disables the button, shows errors as toasts.
export function busy(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-busy');                          // a spinner on the button straight away, so the tap shows
    btn.setAttribute('aria-busy', 'true');
    try { await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); } finally { btn.disabled = false; btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy'); }
  };
}

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function mapsLink(g) {
  if (g.lat != null && g.lng != null) return `https://www.google.com/maps?q=${g.lat},${g.lng}`;
  return g.ground ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.ground + ' ' + (g.address || ''))}` : null;
}

// Pages are real paths (/admin/members, /join/bcdca). The server sends every path to index.html and this runs the screen.
export const routePath = () => location.pathname.replace(/\/+$/, '') || '/';
export function navigate(path, { replace = false } = {}) {
  if (location.pathname + location.search !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  window.dispatchEvent(new Event('route'));
}
