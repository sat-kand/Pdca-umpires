import { applyOrg } from './org-setup.js';
import { viewMember, viewMyProfile } from './views-member.js';
import { CONFIG, DEMO_ORG } from './config.js';
import { h, setChildren, spinner, toast, navigate, routePath } from './ui.js';
import { createDemoStore } from './store-demo.js';
import { seedDemo } from './demo-seed.js';
import { viewLogin, viewProfile, viewMy } from './views-umpire.js';
import { viewOrgSettings } from './views-org.js';
import { viewAssociations, viewJoin } from './views-join.js';
import { membershipOf } from './logic.js';
import { viewAdminHome, viewPastAllocations, viewBoard, viewAvailabilityOverview, viewSeasonAvailability, viewReport, viewUmpires } from './views-admin.js';

const S = { store: null, user: null, org: null, isAdmin: false, umpire: null };
const ORG_KEY = 'pdca-org';            // the association this browser last used
// Links shared before pages had real paths (/#/join/bcdca) still work.
if (/^#\/./.test(location.hash)) history.replaceState(null, '', location.hash.slice(1));
const NEXT_KEY = 'pdca-join-next';      // an association's join link opened before signing in: where to go once they have
const main = document.getElementById('app');
const header = document.getElementById('top');
let renderId = 0;

const go = path => navigate(path);

async function loadUser(user) {
  S.user = user; S.isAdmin = false; S.umpire = null; S.org = null; S.myOrgs = []; S.officerIn = []; S.pending = 0;
  await S.store.useOrg(null);
  if (!user) return;
  try {
    // Someone is only ever "in" an association they have asked to join (or are an officer of): a link or a
    // remembered choice for any other one means nothing until they have joined it.
    S.myOrgs = await S.store.listMyOrgs(user.email);             // every association they are an officer or member of (or waiting to join): the switcher
    const mine = S.myOrgs.map(o => o.id);
    let id = localStorage.getItem(ORG_KEY);
    // Nobody has to pick one: My page shows them all. Open the first by name until they use another.
    S.myOrgs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!mine.includes(id)) id = S.myOrgs.length ? S.myOrgs[0].id : null;
    try { S.officerIn = (S.store.listStandings ? await S.store.listStandings(user.email) : []).filter(st => st.officer).map(st => st.orgId); } catch { S.officerIn = []; }
    S.org = id ? await S.store.useOrg(id) : null;
    applyOrg(S.org);
    if (id && !S.org) localStorage.removeItem(ORG_KEY);
  } catch (e) { console.warn('association load failed', e); }
  if (!S.org) return;
  localStorage.setItem(ORG_KEY, S.org.id);
  try { S.isAdmin = await S.store.isAdmin(user.email); } catch (e) { console.warn('admin check failed', e); }
  try { S.umpire = await S.store.getUmpire(user.email); } catch (e) { console.warn('umpire load failed', e); }
  if (S.isAdmin) await refreshPending(true);
}
// People waiting to join the open association, for the officer's badge and banner.
async function refreshPending(quiet) {
  if (!S.isAdmin || !S.store.listJoinRequests) { S.pending = 0; return; }
  try { S.pending = (await S.store.listJoinRequests()).filter(u => membershipOf(u) === 'applied').length; } catch (e) { console.warn('join requests', e); S.pending = 0; }
  if (!quiet) drawHeader();
}
// Switching association keeps the page they are on, showing that association's content instead.
async function chooseOrg(id, opts = {}) {
  localStorage.setItem(ORG_KEY, id);
  S.openGroup = opts.open || '';                        // a group to open on My availability
  if (S.user) await loadUser(S.user);
  const path = routePath();
  if (path === '/associations' || path.startsWith('/join/')) return go('/');
  if (path.startsWith('/admin') && !S.isAdmin) return go('/');      // not an officer there: their umpire page
  if (path.startsWith('/admin/round/')) return go('/admin');        // a round belongs to the association it came from
  render();
}
// Someone in more than one association (an officer of several, say) can switch at any time from the menu.
function switchItems() {
  const others = (S.myOrgs || []).filter(o => !S.org || o.id !== S.org.id);
  if (!others.length) return [];
  return [h('hr'), h('div', { class: 'menu-head muted small' }, 'Switch association'),
    ...others.map(o => h('button', { class: 'nav-link menu-switch', type: 'button', onclick: () => chooseOrg(o.id) }, o.name))];
}
const ctx = { get store() { return S.store; }, S, go, refreshUser: () => loadUser(S.user), refreshPending: () => refreshPending(), chooseOrg, redrawHeader: () => drawHeader() };

const ROUTES = [
  [/^\/$/, () => viewMy(ctx)],
  [/^\/my$/, () => viewMy(ctx)],
  [/^\/profile$/, () => (S.umpire ? viewMyProfile(ctx) : viewProfile(ctx))],
  [/^\/profile\/edit$/, () => viewProfile(ctx)],
  [/^\/admin$/, () => viewAdminHome(ctx), true],
  [/^\/admin\/past$/, () => viewPastAllocations(ctx), true],
  [/^\/admin\/availability$/, () => viewSeasonAvailability(ctx), true],
  [/^\/admin\/(?:members|umpires)$/, () => viewUmpires(ctx), true],   // the old /umpires link still works
  [/^\/admin\/settings$/, () => viewOrgSettings(ctx), true],
  [/^\/admin\/member\/([^/]+)$/, pid => viewMember(ctx, pid), true],
  [/^\/admin\/round\/([^/]+)$/, rid => viewBoard(ctx, rid), true],
  [/^\/admin\/round\/([^/]+)\/availability$/, rid => viewAvailabilityOverview(ctx, rid), true],
  [/^\/admin\/round\/([^/]+)\/report$/, rid => viewReport(ctx, rid), true],
];

// A menu closes when you tap anywhere else, or press Escape.
document.addEventListener('click', e => { for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const m of document.querySelectorAll('details.menu[open]')) m.open = false; });

function drawHeader() {
  const demo = S.store.mode === 'demo';
  const link = (href, label) => h('a', { href, class: 'nav-link' }, label);
  setChildren(header,
    demo && h('div', { class: 'demo-banner' }, 'Demo mode — data is stored only in this browser. ',
      h('button', { class: 'link', type: 'button', onclick: async ev => {
        await S.store.useOrg(S.org ? S.org.id : DEMO_ORG.id);      // works for anyone in the demo, signed in or not
        const b = ev.currentTarget; b.disabled = true; b.textContent = 'Loading sample data…';
        try { const r = await seedDemo(S.store); toast(`Loaded sample umpires and made-up fixtures (${r.games} games)`, 'ok'); } finally { if (S.user) await loadUser(S.user); render(); }
      } }, 'Load sample data'), ' · ',
      h('button', { class: 'link', type: 'button', onclick: () => { if (confirm('Erase all demo data in this browser?')) { localStorage.removeItem(ORG_KEY); S.store.demoReset(); navigate('/'); } } }, 'Reset')),
    h('div', { class: 'bar' },
      h('a', { class: 'brand', href: '/' }, '🏏 ', CONFIG.appName),
      S.isAdmin && h('nav', { class: 'nav' }, link('/admin', 'Allocate'), link('/admin/availability', 'Availability'),
        // Members, Settings and the association picker sit together, out of the way of the weekly work.
        h('details', { class: 'menu' }, h('summary', { class: 'nav-link' }, (S.org && S.org.name) || 'My Organisation', S.pending > 0 && h('span', { class: 'badge', 'aria-label': `${S.pending} waiting to join` }, S.pending)),
          h('div', { class: 'menu-items' }, S.org && h('div', { class: 'menu-head' }, h('strong', {}, S.org.name)),
            link('/admin/members', 'Members'), link('/admin/past', 'Past allocations'), link('/admin/settings', 'Settings'), ...switchItems()))),
      // The account menu, top right as on most sites: their name, then profile, availability and Sign out.
      S.user && (() => {
        const name = (S.umpire && S.umpire.name) || S.user.email;
        const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
        return h('div', { class: 'who' },
          h('details', { class: 'menu who-menu' },
            h('summary', { class: 'who-name', 'aria-label': 'Account menu' }, h('span', { class: 'avatar' }, initials), h('span', { class: 'who-label' }, name)),
            h('div', { class: 'menu-items' },
              h('div', { class: 'menu-head' }, h('strong', {}, name), name !== S.user.email && h('span', { class: 'muted small' }, S.user.email)),
              link('/profile', 'My profile'), link('/my', 'My availability'), link('/associations', 'Associations'),
              ...(S.isAdmin || !(S.officerIn || []).length ? [] : switchItems()),   // only officers switch; everyone else sees all their associations on My availability
              h('hr'),
              h('button', { class: 'nav-link menu-signout', type: 'button', onclick: async () => { await S.store.signOut(); await loadUser(null); navigate('/'); } }, 'Sign out'))));
      })()),
    S.org && S.org.plan === 'suspended' && h('div', { class: 'demo-banner' }, 'This association has been set to read-only, so changes cannot be saved.'));
}

async function render(quiet) {
  if (!S.store) return;
  const id = ++renderId;
  drawHeader();
  const path = routePath();
  const join = /^\/join\/([^/]+)$/.exec(path);          // the link an association sends its umpires
  const joinId = join && decodeURIComponent(join[1]);
  if (joinId && !S.user) { localStorage.setItem(NEXT_KEY, joinId); go('/'); return; }          // sign in first, then come back to it
  const next = S.user && localStorage.getItem(NEXT_KEY);
  if (next && !join) { localStorage.removeItem(NEXT_KEY); go('/join/' + encodeURIComponent(next)); return; }
  if (joinId && (S.myOrgs || []).some(o => o.id === joinId)) { await chooseOrg(joinId); return; }   // already in it (or waiting): just open it
  if (S.user && S.org && S.isAdmin && path === '/') { go('/admin'); return; }
  shownPath = null;                                    // the spinner's scroll position is not anyone's
  if (quiet !== true) setChildren(main, spinner());       // a refresh on returning to the tab keeps the page as it is until the new one is ready
  let view;
  try {
    if (!S.user) view = viewLogin(ctx);
    else if (joinId) view = await viewJoin(ctx, joinId);                 // the details that association asks for
    else if (!S.org || path === '/associations' || (!S.umpire && !S.isAdmin)) view = await viewAssociations(ctx);   // new here: choose an association to join
    else {
      let matched = false;
      for (const [re, fn, adminOnly] of ROUTES) {
        const m = re.exec(path);
        if (!m) continue;
        matched = true;
        view = adminOnly && !S.isAdmin
          ? h('p', { class: 'notice warn' }, 'This page is only for the association.')
          : await fn(...m.slice(1).map(decodeURIComponent));
        break;
      }
      if (!matched) view = h('p', { class: 'notice warn' }, 'Page not found. ', h('a', { href: '/' }, 'Go home'));
    }
  } catch (e) {
    console.error(e);
    view = h('div', { class: 'notice err' }, h('strong', {}, 'Something went wrong. '), e.message || String(e),
      /permission|insufficient/i.test(String(e.message)) ? h('p', {}, 'This usually means this email is not allowed to see this page, or the database permissions have not been set up.') : null);
  }
  if (id !== renderId) return; // a newer navigation superseded this one
  setChildren(main, view);
  restoreScroll(path);
}

// Coming back to a page (Back, a back link, a menu link) returns to where it was left. Kept in memory
// only, so a refresh or a new browser starts at the top.
const scrollAt = new Map();
let shownPath = null;
window.addEventListener('scroll', () => { if (shownPath) scrollAt.set(shownPath, window.scrollY); }, { passive: true });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let userScrolled = false;                             // the person scrolled themselves: stop restoring
for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.addEventListener(ev, () => { userScrolled = true; }, { passive: true });
function restoreScroll(path) {
  const y = scrollAt.get(path) || 0;
  shownPath = path;
  userScrolled = false;
  window.scrollTo(0, y);
  if (Math.abs(window.scrollY - y) < 2) return;
  // A page that fills in after it is shown (fixtures loading, say): try again once it is long enough.
  let tries = 0;
  const again = () => {
    if (shownPath !== path || userScrolled || tries++ > 30) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) >= 2) setTimeout(again, 100);
  };
  setTimeout(again, 100);
}

async function boot() {
  setChildren(main, spinner('Starting…'));
  try {
    if (CONFIG.supabase && CONFIG.supabase.url) {
      const { createSupabaseStore } = await import('./store-supabase.js');
      S.store = await createSupabaseStore(CONFIG.supabase);
    } else S.store = createDemoStore();
    await S.store.init();
  } catch (e) {
    console.error(e);
    setChildren(main, h('div', { class: 'notice err' }, h('strong', {}, 'Could not start. '), e.message || String(e)));
    return;
  }
  window.addEventListener('route', () => render());
  window.addEventListener('popstate', () => render());
  // Links inside the app change the page without reloading it.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.getAttribute('href').startsWith('//')) return;
    e.preventDefault(); navigate(a.getAttribute('href'));
  });
  // Coming back to the officer's pages (another tab, the phone unlocked): redraw, so choices and
  // pull-outs made meanwhile are applied to the board without a manual refresh.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && routePath().startsWith('/admin')) render(true); });
  try { await S.store.completeLink(async () => prompt('To finish signing in, please type the email address the link was sent to:')); }
  catch (e) { if (e && e.signInLink) S.linkProblem = e.message; else toast('Sign-in problem: ' + (e.message || e), 'err'); }
  S.store.onAuth(async user => {
    // The auth library re-announces the same person when the tab regains focus: reloading then would blank the association mid-draw.
    if (user && S.user && S.user.email === user.email && (S.org || S.isAdmin || S.umpire)) return;
    await loadUser(user); render();
  });
}

boot();
window.__pdca = { S, go, render }; // handy for debugging in the browser console
