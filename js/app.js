import { CONFIG, DEMO_ORG } from './config.js';
import { h, setChildren, spinner, toast } from './ui.js';
import { createDemoStore } from './store-demo.js';
import { seedDemo } from './demo-seed.js';
import { viewLogin, viewProfile, viewMy } from './views-umpire.js';
import { viewAssociations, viewOrgSettings } from './views-org.js';
import { viewAdminHome, viewBoard, viewAvailabilityOverview, viewSeasonAvailability, viewReport, viewUmpires } from './views-admin.js';

const S = { store: null, user: null, org: null, isAdmin: false, umpire: null };
const ORG_KEY = 'pdca-org';            // the association this browser last used
const JOIN_KEY = 'pdca-org-joining';   // set when it was just chosen (join link, picker or sign-up)
const main = document.getElementById('app');
const header = document.getElementById('top');
let renderId = 0;

const go = path => { if (location.hash === '#' + path) render(); else location.hash = '#' + path; };

async function loadUser(user) {
  S.user = user; S.isAdmin = false; S.umpire = null; S.org = null;
  await S.store.useOrg(null);
  if (!user) return;
  try {
    let id = localStorage.getItem(ORG_KEY);
    // Arriving by a link (or having just picked one) wins. Otherwise use the association this browser last used,
    // unless this person belongs to others and not that one (a shared computer).
    if (!localStorage.getItem(JOIN_KEY)) {
      const mine = (await S.store.listMyOrgs(user.email)).map(o => o.id);
      if (mine.length && !mine.includes(id)) id = mine.length === 1 ? mine[0] : null;
    }
    if (!id && S.store.mode === 'demo') id = DEMO_ORG.id;      // the demo has one built-in association: nobody needs a link to try it
    S.org = id ? await S.store.useOrg(id) : null;
    if (id && !S.org) { localStorage.removeItem(ORG_KEY); if (localStorage.getItem(JOIN_KEY)) toast('That association link is not valid.', 'err'); }
  } catch (e) { console.warn('association load failed', e); }
  const joining = localStorage.getItem(JOIN_KEY);
  localStorage.removeItem(JOIN_KEY);
  if (!S.org) return;
  localStorage.setItem(ORG_KEY, S.org.id);
  if (joining) { try { await S.store.rememberOrg(user.email, S.org.id); } catch (e) { console.warn('could not remember association', e); } }
  try { S.isAdmin = await S.store.isAdmin(user.email); } catch (e) { console.warn('admin check failed', e); }
  try { S.umpire = await S.store.getUmpire(user.email); } catch (e) { console.warn('umpire load failed', e); }
}
async function chooseOrg(id) {
  localStorage.setItem(ORG_KEY, id); localStorage.setItem(JOIN_KEY, '1');
  if (S.user) await loadUser(S.user);
  go('/');
}
const ctx = { get store() { return S.store; }, S, go, refreshUser: () => loadUser(S.user), chooseOrg, redrawHeader: () => drawHeader() };

const ROUTES = [
  [/^\/$/, () => viewMy(ctx)],
  [/^\/my$/, () => viewMy(ctx)],
  [/^\/profile$/, () => viewProfile(ctx)],
  [/^\/admin$/, () => viewAdminHome(ctx), true],
  [/^\/admin\/availability$/, () => viewSeasonAvailability(ctx), true],
  [/^\/admin\/(?:members|umpires)$/, () => viewUmpires(ctx), true],   // the old /umpires link still works
  [/^\/admin\/settings$/, () => viewOrgSettings(ctx), true],
  [/^\/admin\/round\/([^/]+)$/, rid => viewBoard(ctx, rid), true],
  [/^\/admin\/round\/([^/]+)\/availability$/, rid => viewAvailabilityOverview(ctx, rid), true],
  [/^\/admin\/round\/([^/]+)\/report$/, rid => viewReport(ctx, rid), true],
];

function drawHeader() {
  const demo = S.store.mode === 'demo';
  const link = (href, label) => h('a', { href, class: 'nav-link' }, label);
  setChildren(header,
    demo && h('div', { class: 'demo-banner' }, 'Demo mode — data is stored only in this browser. ',
      h('button', { class: 'link', type: 'button', onclick: async ev => {
        await S.store.useOrg(S.org ? S.org.id : DEMO_ORG.id);      // works for anyone in the demo, signed in or not
        const b = ev.currentTarget; b.disabled = true; b.textContent = 'Loading real PDCA fixtures…';
        try { const r = await seedDemo(S.store); toast(r.live ? `Loaded the real PDCA fixtures (${r.games} games) and sample umpires` : 'Play Cricket not reachable: loaded made-up sample fixtures'); } finally { if (S.user) await loadUser(S.user); render(); }
      } }, 'Load sample data'), ' · ',
      h('button', { class: 'link', type: 'button', onclick: () => { if (confirm('Erase all demo data in this browser?')) { localStorage.removeItem(ORG_KEY); S.store.demoReset(); location.hash = '#/'; } } }, 'Reset')),
    h('div', { class: 'bar' },
      h('a', { class: 'brand', href: '#/' }, '🏏 ', CONFIG.appName),
      S.isAdmin && h('nav', { class: 'nav' }, link('#/admin', 'Allocate'), link('#/admin/availability', 'Availability'),
        // Members, Settings and the association picker sit together, out of the way of the weekly work.
        h('details', { class: 'menu' }, h('summary', { class: 'nav-link' }, 'Manage'),
          h('div', { class: 'menu-items' }, link('#/admin/members', 'Members'), link('#/admin/settings', 'Settings'), link('#/associations', 'Your associations'))),
        link('#/my', 'My availability')),
      S.user && h('div', { class: 'who' },
        h('a', { class: 'who-name', href: '#/profile', title: 'Edit my details' }, (S.umpire && S.umpire.name) || S.user.email),
        h('button', { class: 'btn small', type: 'button', onclick: async () => { await S.store.signOut(); location.hash = '#/'; } }, 'Sign out'))),
    S.org && S.org.plan === 'suspended' && h('div', { class: 'demo-banner' }, 'This association has been set to read-only, so changes cannot be saved.'));
}

async function render() {
  if (!S.store) return;
  const id = ++renderId;
  drawHeader();
  const path = location.hash.slice(1) || '/';
  const join = /^\/join\/([^/]+)$/.exec(path);          // the link an association sends its umpires
  if (join) { if (S.user) await chooseOrg(decodeURIComponent(join[1])); else { localStorage.setItem(ORG_KEY, decodeURIComponent(join[1])); localStorage.setItem(JOIN_KEY, '1'); go('/'); } return; }
  if (S.user && S.org && S.isAdmin && path === '/') { go('/admin'); return; }
  setChildren(main, spinner());
  let view;
  try {
    if (!S.user) view = viewLogin(ctx);
    else if (!S.org || path === '/associations') view = await viewAssociations(ctx);
    else if (!S.umpire && !S.isAdmin && path !== '/profile') view = await viewProfile(ctx);
    else {
      let matched = false;
      for (const [re, fn, adminOnly] of ROUTES) {
        const m = re.exec(path);
        if (!m) continue;
        matched = true;
        view = adminOnly && !S.isAdmin
          ? h('p', { class: 'notice warn' }, 'This page is only for appointments officers.')
          : await fn(...m.slice(1).map(decodeURIComponent));
        break;
      }
      if (!matched) view = h('p', { class: 'notice warn' }, 'Page not found. ', h('a', { href: '#/' }, 'Go home'));
    }
  } catch (e) {
    console.error(e);
    view = h('div', { class: 'notice err' }, h('strong', {}, 'Something went wrong. '), e.message || String(e),
      /permission|insufficient/i.test(String(e.message)) ? h('p', {}, 'This usually means the Firestore security rules have not been published, or this email is not allowed to see this page.') : null);
  }
  if (id !== renderId) return; // a newer navigation superseded this one
  setChildren(main, view);
  window.scrollTo(0, 0);
}

async function boot() {
  setChildren(main, spinner('Starting…'));
  try {
    if (CONFIG.firebase.apiKey) {
      const { createFirebaseStore } = await import('./store-firebase.js');
      S.store = await createFirebaseStore(CONFIG.firebase);
    } else S.store = createDemoStore();
    await S.store.init();
  } catch (e) {
    console.error(e);
    setChildren(main, h('div', { class: 'notice err' }, h('strong', {}, 'Could not start. '), e.message || String(e)));
    return;
  }
  window.addEventListener('hashchange', render);
  try { await S.store.completeLink(async () => prompt('To finish signing in, please type the email address the link was sent to:')); }
  catch (e) { toast('Sign-in link problem: ' + (e.message || e), 'err'); }
  S.store.onAuth(async user => { await loadUser(user); render(); });
}

boot();
window.__pdca = { S, go, render }; // handy for debugging in the browser console
