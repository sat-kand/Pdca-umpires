// Screens for the appointments officer.

import { h, toast, setChildren, busy, copyText, mapsLink, todayLocal, navigate } from './ui.js';
import {
  fmtDay, fmtRange, gradeShort, compareGrades, groupSections, allocFor, buildBusyMap, assignmentWarnings,
  slotOptions, recount, summarise, formatSummary, publishState, nameParts, fullName, compareMembers, seasonLoads, autoAllocate, applyChanges, umpireText, slotCount, isPicked, newPid, emailKey,
  joinFieldsFor, joinSettings,
  availStatus, availKey, compLabel, compKeyOf, roundColumns, COMPS, reliabilityOf, publishedSnapshot, umpiresForGrade, suggestUmpires, firstGroup, groupNeedsUmpires, memberStatus, STATUS_LABEL, STATUS_CHIP, membershipOf, MEMBERSHIP_LABEL, MEMBERSHIP_CHIP, MEMBER_CHANGE, canUmpire, isActiveUmpire,
} from './logic.js';
import { saveReportPdf } from './report-pdf.js';
import { applyWithdrawals, dismissWithdrawals } from './withdrawals.js';
import { applyPlayerUmpires, claimsFrom, playerUmpireAllowed } from './player-umpire.js';
const puEnabled = store => playerUmpireAllowed(store.org) && !!(store.org.playerUmpire && store.org.playerUmpire.enabled);
import { membershipTypes, feeFor, money } from './views-org.js';
import { membershipLink } from './views-member.js';
const profileLink = u => h('a', { class: 'member-link', href: `/admin/member/${encodeURIComponent(u.pid)}`, title: 'Open profile' }, u.name);
import { planImport, applyImport } from './import-availability.js';
import { planMembers, applyMembers } from './import-members.js';
import { syncFixtures, refreshRound, currentRound, visibleRounds, needsSync, addDays, weekOf, upcomingRounds } from './rounds.js';

// A finished round can still be changed for this many days after its last game (an umpire replaced on
// the morning, say). After that it is a record: Availability and Report only, no Assign board.
const EDIT_DAYS_AFTER = 4;
// Suspended or rejected: not offered for games and left off availability sheets.
const barred = u => ['suspended', 'rejected'].includes(membershipOf(u));
const homeMembers = { filter: 'all', q: '', importOpen: false, comp: '', avail: { importOpen: true } };   // kept while the page is open
const editableUntil = r => addDays(r.end || r.start || '', EDIT_DAYS_AFTER);
const isLocked = (r, today = todayLocal()) => !!(r && (r.end || r.start)) && editableUntil(r) < today;

const SLOT_CHOICES = [[1, '1 umpire'], [2, '2 umpires']];

const roundHeading = r => `${r.comp ? compLabel(r.comp) + ' · ' : ''}${r.title}`;

function tabs(rid, active, locked = false) {
  // A finished, locked round is a record: just its report.
  const t = locked ? [['/report', 'Report']] : [['', 'Assign'], ['/availability', 'Availability'], ['/report', 'Report & email']];
  return h('nav', { class: 'tabs noprint' }, t.map(([p, label]) =>
    h('a', { class: 'tab' + (active === p ? ' active' : ''), href: `/admin/round/${rid}${p}` }, label)),
  h('a', { class: 'tab right', href: '/admin' }, '← Back to Allocate'));
}

// ---------------------------------------------------------------------------
// Allocate: one tile per competition showing its next round
// ---------------------------------------------------------------------------

// "Select grades" popup: tick the grades the committee wants umpires for. Only ticked grades are
// listed on the board, and the slot totals follow. `onDone` runs after saving.
async function openGradesModal({ store, round, chosenGames = new Set(), onDone }) {
  const [games, settings] = await Promise.all([store.listGames(round.id), store.getSettings()]);
  // Grades the association set to 0 umpires (Blast, under-11s, ...) are never offered.
  const live = games.filter(g => !g.removed && compKeyOf(g) === (round.comp || firstGroup()) && umpiresForGrade(g.grade) !== 0);
  const grades = [...new Set(live.map(g => g.grade))].sort(compareGrades);
  const count = gr => live.filter(g => g.grade === gr).length;
  // Umpires per game: what the board has, else what the association set for the grade, else 1.
  const perGame = g => ((g.slots || 0) || umpiresForGrade(g.grade) || 1);
  // A game turned on only because a player umpire chose it does not count as selecting its grade.
  const want = Object.fromEntries(grades.map(gr => [gr, live.some(g => g.grade === gr && isPicked(g) && !g.puOnly)]));
  const hasPu = g => Object.values(g.alloc || {}).some(arr => (arr || []).some(a => a && a.pu));
  const isPuGame = g => chosenGames.has(g.id) || hasPu(g);         // chosen right now, or in it as a player umpire
  const puGames = gr => live.filter(g => g.grade === gr && isPicked(g) && isPuGame(g)).length;
  const typeOf = gr => formatSummary(live.filter(g => g.grade === gr));              // the competition's match type: One Day / Two Day / T20

  const dlg = h('dialog', { class: 'modal', 'aria-label': 'Select grades' });
  const total = h('span', { class: 'muted' });
  const rows = grades.map(gr => {
    const cb = h('input', { type: 'checkbox', checked: want[gr], id: 'g-' + gr.replace(/\W+/g, '_') });
    cb.onchange = () => { want[gr] = cb.checked; showTotal(); };
    return { gr, cb, row: h('label', { class: 'grade-row' }, cb, h('span', { class: 'chip grade' }, gradeShort(gr)), h('span', { class: 'muted' }, `${count(gr)} game${count(gr) === 1 ? '' : 's'}`),
      h('span', { class: 'muted' }, typeOf(gr)),
      puGames(gr) > 0 && h('span', { class: 'chip pu' }, `${puGames(gr)} player umpire game${puGames(gr) === 1 ? '' : 's'}`)) };
  });
  function showTotal() {
    const picked = grades.filter(gr => want[gr]);
    const slots = picked.reduce((n, gr) => n + live.filter(g => g.grade === gr).reduce((m, g) => m + perGame(g) * g.days.length, 0), 0);
    total.textContent = picked.length ? `${picked.length} grade${picked.length === 1 ? '' : 's'} · ${slots} umpire slots` : 'No grades selected';
  }
  const setAll = on => { rows.forEach(r => { r.cb.checked = on; want[r.gr] = on; }); showTotal(); };
  const done = h('button', { class: 'btn primary', type: 'button' }, 'Done');
  done.onclick = busy(done, async () => {
    const changed = [];
    for (const g of games) {
      const mine = !g.removed && (g.grade in want) && compKeyOf(g) === (round.comp || firstGroup());
      if (!mine) continue;
      if (want[g.grade]) {                                   // the grade is selected: every game, and none is "player umpire only" any more
        const n = perGame(g);
        if (n !== (g.slots || 0) || g.puOnly) { g.slots = n; g.puOnly = false; changed.push({ ...g }); }
      } else if (isPuGame(g)) {
        // A game a player umpire chose stays on by itself when its grade is unticked.
        if (!g.puOnly || !g.slots) { g.slots = g.slots || 1; g.puOnly = true; changed.push({ ...g }); }
      } else if (g.slots) { g.slots = 0; changed.push({ ...g }); }
    }
    if (changed.length) await store.saveGames(round.id, changed);
    const patch = { ...summarise(games), changedAt: new Date().toISOString() };
    await store.saveRound({ id: round.id, ...patch });
    Object.assign(round, patch);
    const slotsByGrade = { ...(settings.slotsByGrade || {}) };
    for (const gr of grades) slotsByGrade[gr] = want[gr] ? Math.max(...live.filter(g => g.grade === gr).map(perGame)) : 0;   // remembered for the next round
    await store.saveSettings({ slotsByGrade });
    dlg.close(); dlg.remove();
    if (onDone) await onDone();
  });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel');
  dlg.append(
    h('h2', {}, `${compLabel(round.comp || firstGroup())} · ${round.title}`),
    h('p', { class: 'muted' }, 'Tick the grades that need umpires.'),
    h('div', { class: 'row-between' }, total, h('span', {}, h('button', { class: 'link', type: 'button', onclick: () => setAll(true) }, 'All'), ' · ', h('button', { class: 'link', type: 'button', onclick: () => setAll(false) }, 'None'))),
    h('div', { class: 'grade-list' }, rows.map(r => r.row), !grades.length && h('p', { class: 'muted' }, 'No games in this round.')),
    h('div', { class: 'modal-actions' }, cancel, done));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  showTotal();
  dlg.showModal();
}

const homeWeeks = { more: 0 };             // kept for this page load only

export async function viewAdminHome(ctx) {
  const { store } = ctx;
  const today = todayLocal();
  const wrap = h('div');
  // Weeks loaded with "Load next week" stay loaded until the page is refreshed or the browser closed.
  const state = { rounds: [], season: null, syncing: false, error: '', more: homeWeeks.more, dropouts: [] };

  async function load() {
    state.dropouts = await applyWithdrawals(store);         // umpires who pulled out of a published round, until the officer says 'Got it'
    try { state.pu = await applyPlayerUmpires(store, { today, enabled: puEnabled(store) }); } catch (e) { console.error('player umpires', e); }
    [state.rounds, state.season] = await Promise.all([store.listRounds(), store.getSeason()]);
  }

  const empty = c => h('div', { class: 'card comp-tile empty' }, h('h2', {}, c.label), h('p', { class: 'muted' }, state.syncing ? 'Loading fixtures…' : 'No upcoming games'));

  const startDay = Number.isInteger(store.org && store.org.weekStart) ? store.org.weekStart : 1;
  // A tile shows only its own week's days; a two-day game's second day next week is a note, not a date.
  function tile(r, week) {
    const c = COMPS.find(x => x.key === r.comp) || { label: compLabel(r.comp) };
    const st = r.stats || { needed: 0, filled: 0 };
    const picked = r.picked || 0;
    const end = addDays(week, 6);
    const here = (r.dates || []).filter(d => d >= week && d <= end);
    const later = (r.dates || []).filter(d => d > end);
    return h('div', { class: 'card comp-tile' },
      h('a', { class: 'tile-body', href: `/admin/round/${r.id}` },
        h('h2', {}, c.label),
        Array.isArray(r.starts) && r.starts.length
          // One line per start day, so games on Saturday and on Sunday are not read as one two-day game.
          ? h('ul', { class: 'plain tile-starts' }, r.starts.map(s => h('li', {},
            h('strong', { class: 'tile-round' }, fmtDay(s.date)), ' ',
            h('span', { class: 'muted' }, `${s.n} ${s.type ? s.type + ' ' : ''}game${s.n === 1 ? '' : 's'}`
              + (s.later.length ? `, ${s.later.length === 1 ? 'day 2' : 'then'} ${s.later.map(d => fmtDay(d).replace(/ /g, '\u00a0')).join(' or ')}` : '')
              + (s.noLater ? ` (${s.noLater} with no day 2 in the fixtures yet)` : '')))))
          : [h('div', { class: 'tile-round' }, here.map(d => fmtDay(d)).join(' & ')),
            h('div', { class: 'muted' }, r.formats || '', later.length ? ` \u00b7 continues ${later.map(fmtDay).join(' & ')}` : '')],
        h('div', { class: 'tile-stats' },
          picked
            // Games, not places: a two-day game is one game, filled only when every place on both days is.
            ? [h('span', { class: 'chip' }, `${picked} grade${picked === 1 ? '' : 's'} selected`), ' ',
               (n => h('span', { class: 'chip ' + (st.games && n >= st.games ? 'ok' : 'warn') }, `${n} / ${st.games || 0} filled`))(st.gamesFilled ?? 0), ' ',
               (p => h('span', { class: 'chip ' + p.cls }, p.short))(publishState(r))]
            : h('span', { class: 'chip warn' }, 'Choose grades'))));
  }
  const weekName = w => {
    const now = weekOf(today, startDay);
    return w === now ? 'This week' : w === addDays(now, 7) ? 'Next week' : w < now ? 'Started last week' : `Week of ${fmtDay(w)}`;
  };
  // Second days of two-day games that started in an earlier week, shown under the week they fall in.
  const continuing = week => upcomingRounds(state.rounds, today).filter(r => groupNeedsUmpires(r.comp))
    .filter(r => weekOf(r.start, startDay) < week && (r.dates || []).some(d => d >= week && d <= addDays(week, 6)))
    .map(r => h('li', {}, h('a', { href: `/admin/round/${r.id}` }, `${compLabel(r.comp)}: two-day games from ${fmtDay(r.start)}`),
      ` continue ${(r.dates || []).filter(d => d >= week && d <= addDays(week, 6)).map(fmtDay).join(' & ')} (allocated previous week)`));

  function draw() {
    // Groups whose grades are all set to None need no umpires: no tile.
    const shown = visibleRounds(state.rounds.filter(r => groupNeedsUmpires(r.comp)), today, state.more, startDay);
    setChildren(wrap,
      h('div', { class: 'row-between' }, h('h1', {}, 'Allocate'), state.syncing && h('span', { class: 'muted' }, 'Updating fixtures…')),
      state.error && h('p', { class: 'notice warn' }, state.error, ' ', h('button', { class: 'link', type: 'button', onclick: () => sync(true) }, 'Try again')),
      state.pu && (state.pu.added.length + state.pu.removed.length + state.pu.blocked.length) > 0 && h('div', { class: 'notice pu-note' },
        h('strong', {}, 'Player umpires'),
        h('ul', { class: 'plain' },
          state.pu.added.map(x => h('li', {}, `${x.name} chose `, h('a', { href: `/admin/round/${x.roundId}` }, `${x.label} (${fmtDay(x.date)})`), ' \u2014 added to the board')),
          state.pu.removed.map(x => h('li', {}, `${x.name} no longer wants `, h('a', { href: `/admin/round/${x.roundId}` }, `${x.label} (${fmtDay(x.date)})`), ' \u2014 taken off')),
          state.pu.blocked.map(x => h('li', { class: 'warn-text' }, `${x.name} chose `, h('a', { href: `/admin/round/${x.roundId}` }, `${x.label} (${fmtDay(x.date)})`), ', but both places are taken')))),
      ctx.S.pending > 0 && h('div', { class: 'notice warn join-banner' },
        h('strong', {}, `${ctx.S.pending} ${ctx.S.pending === 1 ? 'umpire is' : 'umpires are'} waiting to join`), ' ',
        h('a', { href: '/admin/members' }, 'Review join requests')),
      state.dropouts.length > 0 && h('div', { class: 'notice warn dropouts' },
        h('strong', {}, 'Umpires have pulled out of published games'),
        h('ul', { class: 'plain' }, state.dropouts.map(d => h('li', {}, `${d.name}: `,
          d.shown.map((g, i) => [i ? ', ' : '', h('a', { href: `/admin/round/${g.roundId}` }, `${g.label} (${fmtDay(g.date)})`)])))),
        h('p', { class: 'muted' }, 'Those slots are now empty and the games are flagged on the board.'),
        h('button', { class: 'btn small', type: 'button', onclick: async ev => { ev.currentTarget.disabled = true; await dismissWithdrawals(store, state.dropouts); state.dropouts = []; draw(); } }, 'Got it')),
      shown.sets.map(set => h('section', { class: 'week' },
        h('div', { class: 'week-head' }, h('h2', {}, weekName(set.week)), h('span', { class: 'muted' }, `${fmtDay(set.week)} – ${fmtDay(addDays(set.week, 6))}`)),
        (c => c.length > 0 && h('ul', { class: 'plain continuing muted' }, c))(continuing(set.week)),
        h('div', { class: 'cards' }, set.map(r => tile(r, set.week))))),
      (e => e.length > 0 && h('div', { class: 'cards' }, e.map(empty)))(COMPS.filter(c => groupNeedsUmpires(c.key) && !currentRound(state.rounds, c.key, today))),
      shown.hasMore && h('div', { class: 'load-more' }, h('button', { class: 'btn', type: 'button', onclick: () => { state.more = ++homeWeeks.more; draw(); } }, 'Load next week')));
  }

  async function sync(force) {
    if (state.syncing) return;
    state.syncing = true; state.error = ''; draw();
    try { await syncFixtures(store, { today }); await load(); }
    catch (e) { console.error(e); state.error = `Could not load the fixtures (${e.message || e}).`; }
    state.syncing = false; draw();
  }

  await load();
  draw();
  // First visit, or fixtures more than half a day old, or a competition has no round yet: fetch in the background.
  if (store.playhq && needsSync(state.season, state.rounds, today, Date.now(), store.org)) sync();
  return wrap;
}

// Past allocations: finished rounds that were worked on (something allocated, or published), newest first.
export async function viewPastAllocations(ctx) {
  const { store } = ctx;
  const today = todayLocal();
  const past = (await store.listRounds()).filter(r => (r.end || '') < today && (r.published || ((r.stats || {}).filled || 0) > 0))
    .sort((x, y) => (y.start || '').localeCompare(x.start || ''));
  return h('div', {},
    h('h1', {}, 'Past allocations'),
    h('section', { class: 'card past-rounds' },
      !past.length && h('p', { class: 'muted' }, 'Nothing here yet. A round moves here once its last day has passed, if it was published or had umpires allocated.'),
      h('ul', { class: 'plain' }, past.map(r => { const st = r.stats || { needed: 0, filled: 0 };
        const open = !isLocked(r, today);       // still within the days after the game when changes are allowed
        return h('li', {}, h('a', { class: 'past-row', href: open ? `/admin/round/${r.id}` : `/admin/round/${r.id}/report` },
          h('strong', {}, fmtRange(r.dates || [r.start, r.end])), h('span', {}, r.comp ? compLabel(r.comp) : (r.title || '')), h('span', { class: 'muted' }, r.formats || ''),
          h('span', { class: 'chip' }, `${st.filled}/${st.needed} slots filled`), h('span', { class: 'chip ' + (r.published ? 'ok' : 'warn') }, r.published ? 'Published' : 'Not published'),
          open && h('span', { class: 'chip pu' }, `Can change until ${fmtDay(editableUntil(r))}`))); }))));
}

// ---------------------------------------------------------------------------
// Allocation board
// ---------------------------------------------------------------------------

export async function viewBoard(ctx, rid) {
  const { store } = ctx;
  try { await applyWithdrawals(store); } catch (e) { console.error('dropouts', e); }               // anyone who pulled out, first
  try { await applyPlayerUmpires(store, { today: todayLocal(), enabled: puEnabled(store) }); } catch (e) { console.error('player umpires', e); }   // games members chose themselves
  const round = await store.getRound(rid);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  if (isLocked(round)) { navigate(`/admin/round/${rid}/report`, { replace: true }); return h('div'); }   // a finished round is a record now
  const [games, umpires, availList, rounds, settings] = await Promise.all([
    store.listGames(rid), store.listUmpires(), store.listAvailability((round.season && round.season.id) || 'manual'), store.listRounds(), store.getSettings(),
  ]);
  // Anyone with availability can be picked (non-members in a group of their own); suspended or rejected
  // people are never offered, whatever their availability says.
  const pickable = umpires.filter(u => !barred(u));
  const B = { ui: { grades: false, warns: false }, round, games, umpires: pickable, settings, availByEmail: Object.fromEntries(availList.map(a => [a.email, a])) };
  const { claimOf, chosenGames } = claimsFrom(availList, umpires, puEnabled(store));   // games player umpires chose: they come first
  // A game is a player umpire game only while someone has chosen it or is in it as one. Tidy up any
  // left marked from a choice that has since been given back.
  const puIn = g => Object.values(g.alloc || {}).some(arr => (arr || []).some(a => a && a.pu));
  for (const g of games) {
    if (!(g.puOnly || g.puGame) || chosenGames.has(g.id) || puIn(g)) continue;
    const anyone = Object.values(g.alloc || {}).some(arr => (arr || []).some(Boolean));
    if (g.puOnly && !anyone) { g.slots = 0; g.puOnly = false; }
    g.puGame = false;
    await store.saveGame(rid, g);
  }
  const otherStats = rounds.filter(r => r.id !== rid && r.season && round.season && r.season.id === round.season.id).map(r => r.stats);
  const wrap = h('div');

  // Every change to the allocation is stamped, so the board can say whether what umpires can see is current.
  const persistStats = async () => {
    const patch = { ...summarise(B.games), changedAt: new Date().toISOString() };
    Object.assign(B.round, patch);
    await store.saveRound({ id: rid, ...patch });
  };
  // Only the grades the officer picked are listed; the rest of the competition stays out of the way.
  const visible = () => B.games.filter(isPicked);
  const draw = () => { const y = window.scrollY; setChildren(wrap, build()); window.scrollTo(0, y); };
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); draw(); } };

  // A "no longer available" note goes as soon as the officer puts someone new in that game.
  const DROPOUT = / is no longer available on /;
  const newPeople = (g, alloc) => Object.entries(alloc || {}).some(([date, arr]) => {
    const had = new Set(((g.alloc || {})[date] || []).filter(Boolean).map(a => a.p));     // someone new on that day
    return (arr || []).some(a => a && !had.has(a.p));
  });
  async function writeGame(g, patch) {
    if (patch.alloc && DROPOUT.test(g.changeNote || '') && newPeople(g, patch.alloc)) patch = { ...patch, changeNote: '' };
    const next = { ...g, ...patch };
    await store.saveGame(rid, next);
    Object.assign(g, patch);
    await persistStats();
  }

  async function setAlloc(g, date, i, entry) {
    const alloc = structuredClone(g.alloc || {});
    const arr = (alloc[date] ||= []);
    while (arr.length <= i) arr.push(null);
    arr[i] = entry;
    await writeGame(g, { alloc });
    draw();
  }

  // Members who have not answered for any date of this round.
  const noReply = () => { const cols = roundColumns(visible()); return B.umpires.filter(u => canUmpire(u) && cols.every(c => availStatus(B.availByEmail, u, c.comp, c.date) === 'none')); };

  function collectWarnings() {
    const busy = buildBusyMap(B.games), out = [];
    for (const g of visible()) {
      if (g.removed) continue;
      for (const d of g.days) {
        allocFor(g, d.date).forEach((a, i) => {
          if (!a) return;
          const u = B.umpires.find(x => x.pid === a.p);
          if (!u) { out.push({ g, d, text: `${a.n}: umpire not found in the umpire list` }); return; }
          const w = assignmentWarnings({ game: g, date: d.date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy, claimOf });
          if (w.length) out.push({ g, d, text: `${u.name}: ${w.join('; ')}` });
        });
      }
    }
    return out;
  }

  function slotSelect(g, date, i, busyMap, loads) {
    const cur = allocFor(g, date)[i];
    const opts = slotOptions({ game: g, date, slotIndex: i, umpires: B.umpires, availByEmail: B.availByEmail, busy: busyMap, loads, claimOf });
    const multi = g.days.length > 1;
    // Two-day games: umpires free on every day come first, so one pick can cover both days.
    const GROUPS = multi
      ? [['chosen', 'Player umpire (chose this game)'], ['both', 'Available both days'], ['ok', 'Available this day only'], ['nonmember', 'Available Non-Member'], ['none', 'No response yet'], ['allocated', 'Already allocated'], ['unavailable', 'Unavailable']]
      : [['chosen', 'Player umpire (chose this game)'], ['ok', 'Available'], ['nonmember', 'Available Non-Member'], ['none', 'No response yet'], ['allocated', 'Already allocated'], ['unavailable', 'Unavailable']];
    const label = o => `${o.umpire.name}${o.elsewhere ? ' · player umpire elsewhere' : ''}`;
    const sel = h('select', { class: 'slot' + (cur ? '' : ' empty'), 'aria-label': `Umpire ${i + 1}, ${gradeShort(g.grade)} ${g.home.name}, ${fmtDay(date)}`,
      onchange: guard(async () => {
        const u = B.umpires.find(x => x.pid === sel.value);
        if (!u) { await setAlloc(g, date, i, null); return; }
        // Picking someone for Day 1 of a two-day game also fills the empty later days when that
        // umpire is free and clean there. Day 2 can still be changed on its own.
        const alloc = structuredClone(g.alloc || {});
        // Putting a player umpire back in the game they chose marks them as the player umpire again.
        const put = (dt) => { const arr = (alloc[dt] ||= []); while (arr.length <= i) arr.push(null); arr[i] = claimOf(u.pid, dt, compKeyOf(g)) === g.id ? { p: u.pid, n: u.name, pu: true } : { p: u.pid, n: u.name }; };
        put(date);
        let extra = 0;
        const cleanPick = !assignmentWarnings({ game: g, date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy: busyMap, claimOf }).length;
        if (cleanPick && g.days.length > 1 && date === g.days[0].date) {
          for (const d of g.days.slice(1)) {
            if (allocFor(g, d.date)[i]) continue;
            if (!assignmentWarnings({ game: g, date: d.date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy: busyMap, claimOf }).length) { put(d.date); extra++; }
          }
        }
        await writeGame(g, { alloc });
        draw();
        if (extra) toast(`${u.name} also set for ${extra === 1 ? 'Day 2' : 'the other days'} (change it below if needed)`, 'ok');
      }) },
    h('option', { value: '' }, '— unallocated —'),
    GROUPS.map(([k, name]) => {
      const items = opts.filter(o => o.group === k);
      return items.length > 0 && h('optgroup', { label: name }, items.map(o => h('option', { value: o.umpire.pid, selected: !!cur && cur.p === o.umpire.pid }, label(o))));
    }));
    if (cur && !opts.some(o => o.umpire.pid === cur.p)) sel.append(h('option', { value: cur.p, selected: true }, `${cur.n} (inactive)`));
    const warn = cur ? (() => {
      const u = B.umpires.find(x => x.pid === cur.p);
      return u ? assignmentWarnings({ game: g, date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy: busyMap, claimOf }) : ['Umpire not in list'];
    })() : [];
    return h('div', { class: 'slot-wrap' }, sel,
      // The tag follows the person, not the entry: it shows whenever the one who chose this game is in it.
      cur && (cur.pu || claimOf(cur.p, date, compKeyOf(g)) === g.id) && h('span', { class: 'chip pu', title: 'Chose this game themselves' }, 'Player umpire'),
      warn.length > 0 && h('span', { class: 'warn-icon', title: warn.join('\n'), tabindex: 0 }, '⚠'));
  }

  function gameRow(g, busyMap, loads) {
    const n = slotCount(g);
    return h('tr', { class: (g.removed ? 'removed ' : '') + (n && allocFor(g, g.days[0].date).some(a => !a) ? 'needs' : '') },
      h('td', {}, h('span', { class: 'chip grade' }, gradeShort(g.grade))),
      h('td', {}, h('div', {}, g.home.name, h('span', { class: 'muted' }, ' v '), g.away.name),
        g.changeNote && h('div', { class: 'change' }, '✎ ', g.changeNote, ' ',
          h('button', { class: 'link', type: 'button', onclick: guard(async () => { await writeGame(g, { changeNote: '' }); draw(); }) }, 'dismiss'))),
      h('td', {}, mapsLink(g) ? h('a', { href: mapsLink(g), target: '_blank', rel: 'noopener' }, g.ground || '—') : (g.ground || '—'),
        g.days[0].time && h('div', { class: 'muted' }, g.days[0].time)),
      h('td', {}, n ? g.days.map(d => h('div', { class: 'day-block' },
        g.days.length > 1 && h('div', { class: 'day-label' }, `Day ${d.day} · ${fmtDay(d.date)}`),
        Array.from({ length: n }, (_, i) => slotSelect(g, d.date, i, busyMap, loads)))) : h('span', { class: 'muted' }, 'No umpire needed')),
      // How many umpires the game needs: set once, so it sits after the names.
      h('td', {}, g.removed ? h('span', { class: 'chip warn' }, 'removed') : h('select', { class: 'n-slots', 'aria-label': 'Umpires needed', value: String(n),
        onchange: guard(async e => { await writeGame(g, { slots: Number(e.target.value) }); draw(); }) },
      SLOT_CHOICES.map(([v, l]) => h('option', { value: String(v) }, l)))));
  }

  async function doUpdateFixtures() {
    const res = await refreshRound(store, B.round, B.settings);
    if (!res) { toast('This sample round has no live fixture source.', 'warn'); return; }
    B.games = res.all;
    const fresh = await store.getRound(rid);
    Object.assign(B.round, fresh);
    draw();
    toast(res.games.length ? `Fixtures updated: ${res.added} new, ${res.changed} changed, ${res.removed} removed` : 'Fixtures are already up to date');
  }

  function build() {
    const loads = seasonLoads([...otherStats, recount(B.games)]);
    const busyMap = buildBusyMap(B.games);
    const st = recount(B.games);
    const warnings = collectWarnings();
    const sections = groupSections(visible());

    // Publishing is a button, not a tick box, so the state is always readable:
    // never published → Publish; published and current → Published <when>; changed since → Re-publish.
    const pub = publishState(B.round);
    const publishBtn = h('button', { class: 'btn ' + (pub.key === 'live' ? '' : 'primary'), type: 'button', title: pub.label },
      pub.key === 'stale' ? 'Re-publish' : pub.key === 'live' ? pub.label : 'Publish');
    publishBtn.disabled = pub.key === 'live';
    publishBtn.onclick = guard(async () => {
      // Umpires see this copy until the next publish; the officer can keep working on the board meanwhile.
      const patch = { published: true, publishedAt: new Date().toISOString(), publishedAlloc: publishedSnapshot(B.games) };
      Object.assign(B.round, patch);
      await store.saveRound({ id: rid, ...patch });
      const left = st.needed - st.filled;
      toast((pub.key === 'stale' ? 'Re-published: umpires can see the changes' : 'Published: umpires can see their allocations')
        + (left > 0 ? ` (${left} place${left === 1 ? '' : 's'} still empty)` : ''), 'ok');
      draw();
    });
    const unpublishBtn = h('button', { class: 'link', type: 'button' }, 'Unpublish');
    unpublishBtn.onclick = guard(async () => {
      if (!confirm('Hide these allocations from umpires again?')) return;
      Object.assign(B.round, { published: false });
      await store.saveRound({ id: rid, published: false });
      toast('Unpublished: umpires can no longer see this round');
      draw();
    });

    const toggle = (label, field, hint, confirmFn) => {
      const cb = h('input', { type: 'checkbox', checked: !!B.round[field], onchange: guard(async () => {
        if (cb.checked && confirmFn && !confirm(confirmFn())) { cb.checked = false; return; }
        B.round[field] = cb.checked; await store.saveRound({ id: rid, [field]: cb.checked });
        toast(`${label}: ${cb.checked ? 'on' : 'off'}`);
      }) });
      return h('label', { class: 'toggle' }, cb, h('span', {}, h('strong', {}, label), h('small', { class: 'muted' }, hint)));
    };

    const gradesBtn = h('button', { class: 'btn', type: 'button', onclick: () => openGradesModal({ store, round: B.round, chosenGames, onDone: async () => { B.games = await store.listGames(rid); B.settings = await store.getSettings(); B.round = await store.getRound(rid); draw(); } }) }, 'Select grades');

    const autoBtn = h('button', { class: 'btn', type: 'button' }, '✨ Suggest allocations');
    autoBtn.onclick = busy(autoBtn, guard(async () => {
      // Pull-outs after publishing this season, per umpire (ones they took back do not count).
      // Counted by game: a two-day game, kept or pulled out of, counts once.
      const dropped = {};
      const pulledGames = new Set();
      for (const w of await store.listWithdrawals()) for (const r of (w.games || []).filter(r => !r.restored)) {
        if (!w.pid || pulledGames.has(w.pid + '|' + r.roundId + '|' + r.gameId)) continue;
        pulledGames.add(w.pid + '|' + r.roundId + '|' + r.gameId);
        dropped[w.pid] = (dropped[w.pid] || 0) + 1;
      }
      const kept = { ...seasonLoads(otherStats) };
      for (const [p, n] of Object.entries(recount(B.games).byUmpire)) kept[p] = (kept[p] || 0) + n;
      const changes = autoAllocate({ games: B.games, umpires: B.umpires, availByEmail: B.availByEmail, baseLoads: seasonLoads(otherStats), claimOf, reliability: reliabilityOf({ kept, dropped }) });
      if (!changes.length) { toast('No empty slots could be filled with umpires who said "Available".', 'warn'); return; }
      const ids = new Set(changes.map(c => c.gameId));
      const updated = [];
      for (const g of B.games) if (ids.has(g.id)) {
        const alloc = applyChanges(g, changes);
        if (DROPOUT.test(g.changeNote || '') && newPeople(g, alloc)) g.changeNote = '';
        g.alloc = alloc; updated.push(g);
      }
      await store.saveGames(rid, updated);
      await persistStats(); draw();
      toast(`Filled ${changes.length} slot(s). Please review before publishing.`);
    }));
    const updBtn = h('button', { class: 'btn', type: 'button' }, '↻ Update fixtures');
    updBtn.onclick = busy(updBtn, guard(doUpdateFixtures));
    const clearBtn = h('button', { class: 'btn danger', type: 'button' }, 'Clear all');
    clearBtn.onclick = guard(async () => {
      const all = B.games.map(g => ({ ...g, alloc: {} }));
      await store.saveGames(rid, all); all.forEach((x, i) => { B.games[i].alloc = {}; });
      await persistStats(); draw();
    });
    return [
      h('div', { class: 'row-between' }, h('h1', {}, roundHeading(B.round)), h('span', { class: 'muted' }, fmtRange(B.round.dates))),
      tabs(rid, ''),
      h('div', { class: 'card toolbar' },
        h('div', { class: 'actions' }, gradesBtn, autoBtn, updBtn, clearBtn),
        h('div', { class: 'publish' }, publishBtn, B.round.published && unpublishBtn)),
      h('div', { class: 'summary' },
        h('span', { class: 'chip ' + (st.needed && st.filled === st.needed ? 'ok' : 'warn') }, `${st.filled} of ${st.needed} slots filled`),
        h('span', { class: 'chip ' + (warnings.length ? 'warn' : 'ok') }, warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : 'No warnings'),
        noReply().length > 0 && h('span', { class: 'chip' }, `${noReply().length} umpires haven't replied`)),
      warnings.length > 0 && h('details', { class: 'card', open: B.ui.warns, ontoggle: e => { B.ui.warns = e.target.open; } }, h('summary', {}, 'Show warnings'),
        h('ul', {}, warnings.map(w => h('li', {}, `${gradeShort(w.g.grade)} ${w.g.home.name} v ${w.g.away.name}, ${fmtDay(w.d.date)} — ${w.text}`)))),
      sections.map(s => h('section', { class: 'card' },
        h('h2', {}, `${s.label} – ${fmtRange(s.dates)}`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'board alloc-board' },        // stacks into cards on a phone
          h('thead', {}, h('tr', {}, ['Grade', 'Fixture', 'Ground', 'Allocation', 'Umpires'].map(c => h('th', {}, c)))),
          h('tbody', {}, s.games.map(g => gameRow(g, busyMap, loads))))))),
      !sections.length && h('p', { class: 'muted' }, 'No grades selected yet. Press Select grades to choose the grades that need umpires.'),
      h('p', { class: 'muted' }, '"allocated" next to a name means they are already on another game that day. Names are in last-name order.'),
    ];
  }

  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Availability overview
// ---------------------------------------------------------------------------

export async function viewAvailabilityOverview(ctx, rid) {
  const { store } = ctx;
  const round = await store.getRound(rid);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  if (isLocked(round)) { navigate(`/admin/round/${rid}/report`, { replace: true }); return h('div'); }
  const [umpires, availList, allGames] = await Promise.all([store.listUmpires(), store.listAvailability((round.season && round.season.id) || 'manual'), store.listGames(rid)]);
  const by = Object.fromEntries(availList.map(a => [a.email, a]));
  // Members, then people who are not members (yet) but gave availability; never suspended or rejected.
  const active = umpires.filter(u => canUmpire(u) || (!barred(u) && by[u.email] && Object.keys(by[u.email].days || {}).length)).sort(compareMembers);
  // Every playing date of the round, whether or not its grades are selected yet: availability is
  // about the day, and is what helps decide which grades to cover.
  const cols = roundColumns(allGames);
  // Player umpires: the game they chose shows in its competition's column; other competitions show
  // their answers as usual.
  const { pickOf } = claimsFrom(availList, umpires, puEnabled(store));
  const multi = new Set(cols.map(c => c.comp)).size > 1;
  const colName = c => (multi ? `${compLabel(c.comp)} · ` : '') + fmtDay(c.date);
  const missing = active.filter(u => cols.every(c => availStatus(by, u, c.comp, c.date) === 'none' && !pickOf(u.pid, c.date, c.comp)));
  const ICON = { yes: ['✓', 'ok'], no: ['✗', 'no'], none: ['–', 'none'] };
  const counts = c => { const n = { yes: 0, no: 0, none: 0, pu: 0 }; active.forEach(u => { n[pickOf(u.pid, c.date, c.comp) ? 'pu' : availStatus(by, u, c.comp, c.date)]++; }); return n; };
  const emails = missing.map(u => u.email);
  // Available every day of the round, then some days, then player umpires (chose a game here), then
  // not available, then no answer; by last name within each.
  const rank = u => {
    if (cols.some(c => pickOf(u.pid, c.date, c.comp))) return 2;
    const s = cols.map(c => availStatus(by, u, c.comp, c.date));
    const yes = s.filter(x => x === 'yes').length;
    return cols.length && yes === cols.length ? 0 : yes ? 1 : s.includes('no') ? 3 : 4;
  };
  const ordered = [...active].sort((a, b) => Number(!canUmpire(a)) - Number(!canUmpire(b)) || rank(a) - rank(b) || compareMembers(a, b));

  return h('div', {},
    h('div', { class: 'row-between' }, h('h1', {}, roundHeading(round)), h('span', { class: 'muted' }, fmtRange(round.dates))),
    tabs(rid, '/availability', isLocked(round)),
    h('div', { class: 'card' },
      h('div', { class: 'summary' }, cols.map(c => { const n = counts(c); return h('span', { class: 'chip' }, `${colName(c)}: ${n.yes} available · ${n.no} not available · ${n.none} no reply${n.pu ? ` · ${n.pu} player umpire${n.pu === 1 ? '' : 's'}` : ''}`); })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Umpire'), cols.map(c => h('th', {}, colName(c))), h('th', {}, ''))),
        h('tbody', {}, ordered.map(u => h('tr', { class: canUmpire(u) ? '' : 'nonmember' }, h('td', {}, profileLink(u), !canUmpire(u) && h('span', { class: 'chip warn tag' }, 'Non-member')),
          cols.map(c => {
            const p = pickOf(u.pid, c.date, c.comp);
            if (p) return h('td', { class: 'av pu', title: `Chose ${gradeShort(p.grade)}: ${p.label}` },
              h('span', { class: 'chip pu' }, 'Player umpire'), h('div', { class: 'muted small' }, `${gradeShort(p.grade)} \u00b7 ${p.label}`));
            const [t, k] = ICON[availStatus(by, u, c.comp, c.date)]; return h('td', { class: 'av ' + k }, t); }),
          h('td', {}))))))),
    h('div', { class: 'card' }, h('h2', {}, `Haven't replied (${missing.length})`),
      missing.length ? [h('p', {}, missing.map(u => u.name).join(', ')),
        h('button', { class: 'btn', type: 'button', onclick: async () => { { const ok = await copyText(emails.join(', ')); toast(ok ? 'Emails copied' : 'Could not copy', ok ? 'ok' : 'err'); }; } }, 'Copy their emails'), ' ',
        h('a', { class: 'btn', href: `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent('Availability needed: ' + round.title)}&body=${encodeURIComponent('Please check your availability for ' + round.title + ' (' + fmtRange(round.dates) + ') and tap Save.\n\n' + location.origin + location.pathname)}` }, 'Open reminder email')]
        : h('p', { class: 'muted' }, 'Everyone has replied.')));
}

// ---------------------------------------------------------------------------
// Season availability: every umpire against every round / date of one competition
// ---------------------------------------------------------------------------

export async function viewSeasonAvailability(ctx) {
  const { store } = ctx;
  const today = todayLocal();
  const season = await store.getSeason();
  if (!season || !season.calendar || !season.calendar.length) {
    return h('div', {}, h('h1', {}, 'Availability'), h('p', { class: 'notice' }, 'No season dates yet. They load from the fixtures when you open Allocate.'));
  }
  const seasonId = season.id || 'manual';
  const [umpires, availList] = await Promise.all([store.listUmpires(), store.listAvailability(seasonId)]);
  const by = Object.fromEntries(availList.map(a => [a.email, a]));
  // Everyone whose availability is held, members first. Only active members can be appointed, so the
  // rest are marked: they still appear, because their answers came in with the season's import.
  let people = umpires.slice().sort((a, b) => Number(canUmpire(b)) - Number(canUmpire(a)) || compareMembers(a, b));
  const members = () => people.filter(canUmpire);
  const comps = COMPS.filter(c => groupNeedsUmpires(c.key) && season.calendar.some(e => (e.comp || firstGroup()) === c.key));
  const wrap = h('div');
  const ui = { comp: comps[0].key, past: false, q: '', on: null };       // on = show only umpires available on this date
  const ICON = { yes: '\u2713', no: '\u2717', none: '' };
  const KLASS = { yes: 'ok', no: 'no', none: 'none' };
  const NEXT = { none: 'yes', yes: 'no', no: 'none' };
  const draw = () => setChildren(wrap, build());
  const reload = async () => {
    const [us, list] = await Promise.all([store.listUmpires(), store.listAvailability(seasonId)]);
    people = us.slice().sort((a, b) => Number(canUmpire(b)) - Number(canUmpire(a)) || compareMembers(a, b));
    for (const k of Object.keys(by)) delete by[k];
    for (const a of list) by[a.email] = a;
    draw();
  };

  // The officer's change is saved straight away and marked, so it can be told apart from the umpire's own answer.
  async function setCell(u, date, value) {
    const rec = by[u.email] || { seasonId, email: u.email, name: u.name, days: {} };
    const key = availKey(ui.comp, date);
    const days = { ...(rec.days || {}) }, edited = { ...(rec.edited || {}) };
    if (value === 'none') delete days[key]; else days[key] = value;
    edited[key] = true;
    const next = { ...rec, seasonId, email: u.email, name: u.name, days, edited, updatedAt: new Date().toISOString() };
    await store.saveAvailability(next);
    by[u.email] = next;
  }

  function build() {
    // Every competition is laid out the same way: one column per playing date, upcoming dates first.
    const all = [...new Set(season.calendar.filter(e => (e.comp || firstGroup()) === ui.comp).flatMap(e => e.dates))].sort();
    const dates = ui.past ? all : all.filter(d => d >= today);
    const hasPast = all.some(d => d < today);
    if (ui.on && !dates.includes(ui.on)) ui.on = null;
    const st = (u, d) => availStatus(by, u, ui.comp, d);
    const answered = u => (by[u.email] && by[u.email].days && Object.keys(by[u.email].days).some(k => k.startsWith(ui.comp + ':')));
    const mem = members();
    // Someone who has said they don't do this competition (or only chooses their own games) has nothing to answer here.
    const optedOut = u => { const m = (by[u.email] || {}).modes; return !!m && (m.regular === false || (Array.isArray(m.comps) && !m.comps.includes(ui.comp))); };
    const missing = mem.filter(u => !answered(u) && !optedOut(u));
    const emails = missing.map(u => u.email);
    const others = people.filter(u => !canUmpire(u) && !barred(u) && answered(u));
    const q = ui.q.trim().toLowerCase();
    const shownPeople = [...mem, ...others];
    const rows = shownPeople.filter(u => (!q || u.name.toLowerCase().includes(q)) && (!ui.on || st(u, ui.on) === 'yes'));
    const months = [];
    for (const d of dates) { const m = new Date(d + 'T00:00:00Z').toLocaleDateString('en-AU', { month: 'long', timeZone: 'UTC' }); if (months.length && months[months.length - 1][0] === m) months[months.length - 1][1]++; else months.push([m, 1]); }
    const dayHead = d => { const x = new Date(d + 'T00:00:00Z'); return [x.toLocaleDateString('en-AU', { weekday: 'short', timeZone: 'UTC' }), String(x.getUTCDate())]; };
    const countCells = {}, tallyCells = {};
    const count = d => mem.filter(u => st(u, d) === 'yes').length;        // only members can be appointed
    const tally = u => `${dates.filter(d => d >= today && st(u, d) === 'yes').length}/${dates.filter(d => d >= today).length}`;

    const cell = (u, d) => {
      const td = h('td', {});
      const btn = h('button', { type: 'button', class: 'avbtn' });
      const paint = () => {
        const v = st(u, d);
        td.className = 'av ' + KLASS[v] + (d < today ? ' past' : '');
        btn.textContent = ICON[v];
        btn.title = `${u.name}, ${fmtDay(d)}: ${v === 'yes' ? 'Available' : v === 'no' ? 'Not available' : 'No answer'}${by[u.email] && by[u.email].edited && by[u.email].edited[availKey(ui.comp, d)] ? ' (set by the officer)' : ''}. Click to change.`;
        btn.classList.toggle('edited', !!(by[u.email] && by[u.email].edited && by[u.email].edited[availKey(ui.comp, d)]));
      };
      btn.onclick = async () => {
        try { await setCell(u, d, NEXT[st(u, d)]); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); }
        paint();
        if (countCells[d]) countCells[d].textContent = String(count(d));
        if (tallyCells[u.pid]) tallyCells[u.pid].textContent = tally(u);
      };
      paint();
      td.append(btn);
      return td;
    };

    const search = h('input', { type: 'search', placeholder: 'Find an umpire', value: ui.q, 'aria-label': 'Find an umpire', class: 'grid-search' });
    search.oninput = () => { ui.q = search.value; draw(); const s2 = wrap.querySelector('.grid-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } };

    return [
      h('div', { class: 'row-between' }, h('h1', {}, 'Availability'), h('span', { class: 'muted' }, season.name || '')),
      h('nav', { class: 'tabs noprint' }, comps.map(c => h('button', { class: 'tab' + (c.key === ui.comp ? ' active' : ''), type: 'button', onclick: () => { ui.comp = c.key; ui.on = null; draw(); } }, c.label))),
      availabilityImportCard({ store, season, comp: () => ui.comp, people: () => people, by: () => Object.values(by), reload, ui }),
      h('div', { class: 'card' },
        h('div', { class: 'summary' },
          search,
          h('span', { class: 'chip ' + (missing.length ? 'warn' : 'ok') }, `${mem.length - missing.length} of ${mem.length} members have answered`),
          others.length > 0 && h('span', { class: 'chip' }, `${others.length} non-member${others.length === 1 ? '' : 's'}`),
          missing.length > 0 && h('button', { class: 'btn small', type: 'button', onclick: async () => { { const ok = await copyText(emails.join(', ')); toast(ok ? 'Emails copied' : 'Could not copy', ok ? 'ok' : 'err'); }; } }, 'Copy emails of the rest'),
          ui.on && h('button', { class: 'chip ok', type: 'button', onclick: () => { ui.on = null; draw(); } }, `Available ${fmtDay(ui.on)} \u2715`),
          hasPast && h('label', { class: 'inline right' }, (() => { const cb = h('input', { type: 'checkbox', checked: ui.past }); cb.onchange = () => { ui.past = cb.checked; draw(); }; return cb; })(), ' Show past dates')),
        !dates.length ? h('p', { class: 'muted' }, 'No upcoming dates in this competition.')
          : h('div', { class: 'table-wrap season-grid' }, h('table', { class: 'board' },
            h('thead', {},
              h('tr', { class: 'months' }, h('th', { class: 'stick' }, ''), months.map(([m, n]) => h('th', { colspan: n }, m))),
              h('tr', {}, h('th', { class: 'stick' }, 'Umpire'), dates.map(d => { const [w, n] = dayHead(d);
                return h('th', { class: (d < today ? 'past ' : '') + (ui.on === d ? 'on' : '') }, h('button', { type: 'button', class: 'datebtn', title: 'Show only umpires available on ' + fmtDay(d), onclick: () => { ui.on = ui.on === d ? null : d; draw(); } }, h('span', { class: 'sub' }, w), h('span', {}, n))); })),
              h('tr', { class: 'counts' }, h('td', { class: 'stick' }, 'Available'), dates.map(d => (countCells[d] = h('td', { class: d < today ? 'past' : '' }, String(count(d))))))),
            h('tbody', {}, rows.map(u => h('tr', { class: canUmpire(u) ? '' : 'nonmember' },
              h('td', { class: 'stick' }, profileLink(u), ' ', (tallyCells[u.pid] = h('span', { class: 'muted tally' }, tally(u))),
                !canUmpire(u) && h('span', { class: 'chip warn tag' }, STATUS_LABEL[memberStatus(u)])),
              dates.map(d => cell(u, d)))),
              !rows.length && h('tr', {}, h('td', { class: 'stick muted' }, 'Nobody matches'), dates.map(() => h('td', {})))))),
        h('p', { class: 'muted small' }, 'The count under each date is members only \u2014 only an active member can be appointed. Click a cell to change it: \u2713 available \u2192 \u2717 not available \u2192 blank (no answer). A dot marks cells you set. Click a date to list only the umpires available that day.')),
    ];
  }
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Report + email
// ---------------------------------------------------------------------------


export async function viewReport(ctx, rid) {
  const { store } = ctx;
  const [round, games, umpires] = await Promise.all([store.getRound(rid), store.listGames(rid), store.listUmpires()]);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  const sections = groupSections(games.filter(g => !g.removed && isPicked(g)));
  const st = recount(games);
  const pids = new Set(st.byUmpire ? Object.keys(st.byUmpire) : []);
  const emails = umpires.filter(u => pids.has(u.pid)).map(u => u.email);
  const subject = `Umpire allocations: ${round.title}`;
  const link = location.origin + '/';
  const body = `Hi all,\n\nUmpire allocations for ${round.title} are attached/below.\n\nYou can also see your own appointments at ${link}\n\nThanks`;

  const heading = roundHeading(round);
  const save = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    try { saveReportPdf({ heading, dates: round.dates || [], sections }); toast('PDF saved to your downloads', 'ok'); }
    catch (e) { console.error(e); toast('Could not make the PDF: ' + (e.message || e), 'err'); }
  } }, 'Download PDF');
  const copyEmails = h('button', { class: 'btn', type: 'button', onclick: async () => { const ok = (await copyText(emails.join(', '))); toast(ok ? `${emails.length} email addresses copied` : 'Could not copy', ok ? 'ok' : 'err'); } }, `Copy umpire emails (${emails.length})`);
  const draft = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const url = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (url.length > 1900) { await copyText(emails.join(', ')); toast('Too many addresses for a draft, so the emails were copied. Paste them into BCC.', 'warn'); location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }
    else location.href = url;
  } }, 'Open email draft');

  return h('div', {},
    h('div', { class: 'row-between noprint' }, h('h1', {}, roundHeading(round)), h('span', { class: 'muted' }, fmtRange(round.dates))),
    tabs(rid, '/report', isLocked(round)),
    isLocked(round) && h('p', { class: 'notice' }, `This round finished on ${fmtDay(round.end || round.start)}, so it can no longer be changed (allocations stay open for ${EDIT_DAYS_AFTER} days after the last game).`),
    h('div', { class: 'card noprint' },
      st.filled < st.needed && h('p', { class: 'notice warn' }, `${st.needed - st.filled} slot(s) are still unallocated and show as "—" on the report.`),
      !round.published && !isLocked(round) && h('p', { class: 'notice' }, 'This round is not published yet, so umpires cannot see it in the app. Publish it from the Assign tab.'),
      isLocked(round) ? h('p', {}, save) : [h('p', {}, save, ' ', copyEmails, ' ', draft),
        h('p', { class: 'muted' }, 'Download the PDF, then attach it to the email draft.')]),
    h('div', { class: 'report' }, sections.map(s => h('section', { class: 'report-section' },
      h('h2', {}, `${s.label} – ${fmtRange(s.dates)}`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'report-table' },
        h('thead', {}, h('tr', {}, ['', 'HOME TEAM', 'AWAY TEAM', 'GROUND', 'UMPIRES'].map(c => h('th', {}, c)))),
        h('tbody', {}, s.games.map(g => h('tr', {}, h('td', {}, gradeShort(g.grade)), h('td', {}, g.home.name.toUpperCase()), h('td', {}, g.away.name.toUpperCase()),
          h('td', {}, g.ground.toUpperCase()), h('td', { class: slotCount(g) && /—/.test(umpireText(g)) ? 'gap' : '' }, umpireText(g)))))))))));
}

// Bringing in the availability sheet an association already keeps for one group, so umpires do not
// answer twice. Used on the Availability page and on Members. `chooser`, when given, is shown above
// it (the group to import into).
export function availabilityImportCard({ store, season, comp, people, by, reload, ui, chooser = null }) {
  const box = h('textarea', { rows: 6, placeholder: 'Paste the sheet here \u2014 heading row first, one umpire per row.\n\nName\tRound 1 - 20th & 27th Sep\tRound 2 - 11th & 18th Oct\nJ Smith\tDay 1, Day 2\tNot Available' });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain' });
  const addNew = h('input', { type: 'checkbox' });
  const out = h('div', { class: 'import-out' });
  const previewBtn = h('button', { class: 'btn', type: 'button' }, 'Check it');
  const importBtn = h('button', { class: 'btn primary', type: 'button' }, 'Import');
  importBtn.disabled = true;
  let plan = null;

  file.onchange = async () => { const f = file.files && file.files[0]; if (f) { box.value = await f.text(); preview(); } };

  function preview() {
    plan = planImport({ text: box.value, comp: comp(), season, members: people(), availability: by() });
    importBtn.disabled = !!plan.error || !plan.people.length;
    if (plan.error) { setChildren(out, h('p', { class: 'notice warn' }, plan.error)); return; }
    const strangers = plan.strangers.map(p => p.name);
    setChildren(out,
      h('p', {}, h('strong', {}, `${plan.used.length} column${plan.used.length === 1 ? '' : 's'} matched to dates`), ' \u2014 ',
        plan.used.map((c, i) => [i ? ', ' : '', `${c.heading.trim()} \u2192 ${c.dates.map(fmtDay).join(' + ')}`])),
      plan.unmatchedColumns.length > 0 && h('p', { class: 'notice warn' },
        `No ${compLabel(comp())} dates found for: ${plan.unmatchedColumns.join(', ')}. Those columns are skipped.`),
      h('p', {}, `${plan.matched} of ${plan.people.length} people matched a member.`),
      strangers.length > 0 && h('p', { class: 'muted' }, `Not on the Members list: ${strangers.join(', ')}.`,
        plan.strangers.some(p => !p.email) ? ` ${plan.strangers.filter(p => !p.email).length} of them cannot be added because the sheet has no email address for them.` : ' Tick the box below to add them as non-members.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, ['Name', 'Member', 'Available', 'Not available', 'Not understood'].map(c => h('th', {}, c)))),
        h('tbody', {}, plan.people.slice(0, 12).map(p => h('tr', {},
          h('td', {}, p.name),
          h('td', {}, p.member ? (!canUmpire(p.member) ? h('span', { class: 'chip warn' }, MEMBERSHIP_LABEL[membershipOf(p.member)]) : h('span', { class: 'chip ok' }, 'Member')) : h('span', { class: 'chip warn' }, 'Not found')),
          h('td', {}, String(p.yes)), h('td', {}, String(p.no)), h('td', {}, p.unknown ? String(p.unknown) : ''))))),
        plan.people.length > 12 && h('p', { class: 'muted small' }, `\u2026 and ${plan.people.length - 12} more`)));
  }
  previewBtn.onclick = preview;
  box.oninput = () => { importBtn.disabled = true; };

  importBtn.onclick = busy(importBtn, async () => {
    if (!plan) preview();
    if (!plan || plan.error) return;
    if (!confirm(`Import availability for ${plan.people.length} people into ${compLabel(comp())}? Existing answers for these dates are replaced.`)) return;
    try {
      const res = await applyImport(store, plan, { comp: comp(), season, addStrangers: addNew.checked, newPid });
      toast(`${res.saved} imported${res.added ? `, ${res.added} added as non-members` : ''}${res.skipped ? `, ${res.skipped} skipped` : ''}${res.noEmail ? ` (${res.noEmail} had no email address)` : ''}`, res.skipped ? 'warn' : 'ok');
      plan = null;
      box.value = '';
      await reload();
    } catch (e) { console.error(e); toast(e.message || String(e), 'err'); }
  });

  return h('details', { class: 'card import-card', open: ui.importOpen, ontoggle: e => { ui.importOpen = e.currentTarget.open; } },
    h('summary', {}, 'Import from a spreadsheet'),
    chooser,
    h('p', { class: 'muted' }, `Copy the rows out of your own sheet (including the heading row) and paste them here, or choose a CSV file. This replaces ${compLabel(comp())} answers for the dates in the sheet and leaves everything else alone.`),
    box,
    h('p', {}, file),
    h('label', { class: 'inline' }, addNew, ' Add people who are not on the Members list, as non-members (needs an email column in the sheet)'),
    h('p', {}, previewBtn, ' ', importBtn),
    out);
}

// ---------------------------------------------------------------------------
// Umpire list
// ---------------------------------------------------------------------------

export async function viewUmpires(ctx) {
  const { store } = ctx;
  let [members, season] = await Promise.all([store.listUmpires(), store.getSeason ? store.getSeason() : null]);
  // Active umpire or Inactive member comes from this season's availability, never set by hand.
  let availBy = {};
  const loadAvail = async () => { availBy = season ? Object.fromEntries((await store.listAvailability(season.id || 'manual')).map(a => [a.email, a])) : {}; };
  await loadAvail();
  const statusOf = u => memberStatus(u, availBy[u.email]);
  const wrap = h('div');
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); } };
  const ui = homeMembers;                                // the filter and open cards stay while the page is open
  const reload = async () => { members = await store.listUmpires(); await loadAvail(); draw(); };

  // A member's own details (name, date of birth, address, mobile, accreditation) are theirs to keep up
  // to date; the officer only sets what the association decides: approval, active or inactive,
  // membership type, member since.
  const save = (u, patch, redraw = false) => guard(async () => {
    Object.assign(u, patch);
    if (membershipOf(u) === 'member' && !u.memberSince) u.memberSince = todayLocal();     // approved (or added) today
    await store.saveUmpire({ ...u, updatedAt: new Date().toISOString() });
    if (store.saveMembershipLink) store.saveMembershipLink(u.email, membershipLink(store.org, u)).catch(e => console.error('membership link', e));
    if (redraw) draw();
  })();
  const text = v => (v ? v : h('span', { class: 'muted' }, '—'));
  const types = membershipTypes(store.org);
  const membershipTypeCell = u => {
    if (!types.length) return h('a', { class: 'muted', href: '/admin/settings' }, 'Set up types');
    const sel = h('select', { class: 'in-sm', 'aria-label': 'membership', onchange: e => save(u, { membership: e.target.value }) },
      h('option', { value: '' }, '—'), types.map(t => h('option', { value: t.name, selected: u.membership === t.name }, t.name)));
    const fee = feeFor(store.org, u.membership);
    return h('div', { class: 'member-type' }, sel, fee ? h('span', { class: 'muted fee' }, money(fee)) : null);
  };
  // An email draft to a group: their addresses in BCC, so no one sees anyone else's.
  const emailBtn = (label, list) => h('button', { class: 'btn', type: 'button', disabled: !list.length, onclick: async () => {
    const emails = list.map(u => u.email);
    const subject = `${store.org.name || 'Umpires'}: `;
    const url = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(subject)}`;
    if (url.length > 1900) {
      await copyText(emails.join(', '));
      toast('Too many addresses for a draft, so they were copied. Paste them into BCC.', 'warn');
      location.href = `mailto:?subject=${encodeURIComponent(subject)}`;
    } else location.href = url;
  } }, `${label} (${list.length})`);

  // Bringing in the lists an association already keeps: its membership file, then one availability
  // file per group. Both can be repeated; nothing a member typed themselves is overwritten.
  function membershipImport() {
    const box = h('textarea', { rows: 6, placeholder: 'Paste the list here — heading row first, one member per row.\n\nFirst name\tLast name\tEmail\tMobile\tMembership type\tMember since\nJane\tSmith\tj.smith@example.com\t0400 000 000\tOrdinary member\t15/04/2019' });
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain' });
    const out = h('div', { class: 'import-out' });
    const checkBtn = h('button', { class: 'btn', type: 'button' }, 'Check it');
    const importBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Import');
    let plan = null;
    const check = () => {
      plan = planMembers({ text: box.value, members, types });
      importBtn.disabled = !!plan.error;
      if (plan.error) { setChildren(out, h('p', { class: 'notice warn' }, plan.error)); return; }
      setChildren(out,
        h('p', {}, h('strong', {}, `${plan.added.length} new, ${plan.updated.length} already on the list`)),
        plan.updated.length > 0 && h('p', { class: 'muted small' }, 'For people already on the list only membership type and member since are updated. Their own details stay as they keep them.'),
        plan.unknownTypes.length > 0 && h('p', { class: 'notice warn' }, `Not one of your membership types in Settings: ${plan.unknownTypes.join(', ')}. They are imported as written; add the type in Settings to set its fee.`),
        plan.bad.length > 0 && h('p', { class: 'notice warn' }, `${plan.bad.length} row(s) skipped: they need an email address and a name. First: ${plan.bad[0]}`),
        h('ul', { class: 'plain import-preview' }, plan.people.slice(0, 10).map(p => h('li', { class: 'row-between' },
          h('span', {}, h('strong', {}, p.name || p.email), ' ', h('span', { class: 'muted small' }, p.email)),
          h('span', { class: 'chip ' + (p.existing ? '' : 'ok') }, p.existing ? 'Update' : 'New')))),
        plan.people.length > 10 && h('p', { class: 'muted small' }, `… and ${plan.people.length - 10} more`));
    };
    file.onchange = async () => { const f = file.files && file.files[0]; if (f) { box.value = await f.text(); check(); } };
    box.oninput = () => { importBtn.disabled = true; };
    checkBtn.onclick = check;
    importBtn.onclick = busy(importBtn, guard(async () => {
      check();
      if (!plan || plan.error) return;
      const res = await applyMembers(store, plan, { newPid, today: todayLocal() });
      for (const p of plan.people) if (store.saveMembershipLink) {
        const u = { ...(p.existing || {}), email: p.email, membership: p.membership || (p.existing && p.existing.membership) || '', active: true, memberSince: p.memberSince || (p.existing && p.existing.memberSince) || todayLocal() };
        store.saveMembershipLink(p.email, membershipLink(store.org, u)).catch(e => console.error('membership link', e));
      }
      toast(`${res.added} member(s) added, ${res.updated} updated`, 'ok');
      box.value = ''; plan = null; setChildren(out);
      await reload();
    }));
    return h('div', { class: 'import-step' },
      h('p', { class: 'muted' }, 'Your list of members, with a heading row. Columns are found by name: First name, Last name (or Name), Email, Mobile, Membership type and Member since. Copy it out of Excel or Google Sheets and paste it, or choose a CSV file. Everyone in it becomes a member; whether they are an Active umpire follows the availability they give or you bring in next.'),
      box, h('p', {}, file),
      h('p', {}, checkBtn, ' ', importBtn), out);
  }

  // Adding one person by hand: they become a member straight away, the same as a row of the membership file.
  function addMemberCard() {
    const field = (label, attrs) => { const el = h('input', attrs); return [el, h('label', {}, label, el)]; };
    const [first, firstL] = field('First name', { required: true, autocomplete: 'off' });
    const [last, lastL] = field('Last name', { required: true, autocomplete: 'off' });
    const [email, emailL] = field('Email', { type: 'email', required: true, autocomplete: 'off' });
    const [phone, phoneL] = field('Mobile', { type: 'tel', placeholder: 'Optional', autocomplete: 'off' });
    const [since, sinceL] = field('Member since', { type: 'date', value: todayLocal() });
    const type = types.length ? h('select', {}, h('option', { value: '' }, '—'), types.map(t => h('option', { value: t.name }, t.name))) : null;
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Add member');
    const form = h('form', { class: 'add-member', onsubmit: busy(btn, guard(async e => {
      e.preventDefault();
      const key = emailKey(email.value);
      const had = members.find(u => u.email === key) || null;
      if (had && membershipOf(had) === 'member') { toast(`${had.name || key} is already a member.`, 'warn'); return; }
      const p = { email: key, firstName: first.value.trim(), lastName: last.value.trim(), name: had ? had.name : fullName(first.value.trim(), last.value.trim()),
        phone: phone.value.trim(), dob: '', address: '', accreditation: '', accreditationProvider: '',
        membership: type ? type.value : '', memberSince: since.value || todayLocal(), existing: had };
      await applyMembers(store, { people: [p] }, { newPid, today: todayLocal() });
      if (store.saveMembershipLink) store.saveMembershipLink(key, membershipLink(store.org, { ...(had || {}), email: key, membership: p.membership, active: true, memberSince: p.memberSince })).catch(err => console.error('membership link', err));
      toast(`${p.name} added as a member`, 'ok');
      ui.addOpen = false;
      await reload();
    })) },
      h('div', { class: 'two-up' }, firstL, lastL),
      h('div', { class: 'two-up' }, emailL, phoneL),
      h('div', { class: 'two-up' }, type ? h('label', {}, 'Membership type', type) : h('span'), sinceL),
      h('p', { class: 'muted small' }, 'They can sign in with this email to see their games and give their availability, and fill in the rest of their details themselves.'),
      h('p', {}, btn));
    return h('details', { class: 'card add-member-card', open: !!ui.addOpen, ontoggle: e => { ui.addOpen = e.currentTarget.open; } },
      h('summary', {}, 'Add a member'), form);
  }

  // The list: waiting for approval first, then everyone else, by last name. Approving and rejecting is done in the
  // Join requests card above it (or on the member's profile); so is suspending.
  const FILTERS = [['all', 'All'], ['active', 'Active umpires'], ['inactive', 'Inactive members'], ['applied', 'Waiting for approval'],
    ['suspended', 'Suspended'], ['rejected', 'Rejected'], ['nonmember', 'Not members']];
  const inFilter = u => { const st = statusOf(u); return ui.filter === 'all' ? !['rejected', 'nonmember'].includes(st) : st === ui.filter; };
  const change = (list, kind) => guard(async () => {
    for (const u of list) {
      Object.assign(u, MEMBER_CHANGE[kind](u));
      if (membershipOf(u) === 'member' && !u.memberSince) u.memberSince = todayLocal();     // approved (or added) today
      await store.saveUmpire({ ...u, updatedAt: new Date().toISOString() });
      if (store.saveMembershipLink) store.saveMembershipLink(u.email, membershipLink(store.org, u)).catch(e => console.error('membership link', e));
    }
    draw();
    if (ctx.refreshPending) ctx.refreshPending();                // the count beside My Organisation
  })();
  const draw = () => {
    const by = s2 => members.filter(u => statusOf(u) === s2);
    const active = by('active'), inactive = by('inactive');
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? members.filter(u => !['rejected', 'nonmember'].includes(statusOf(u))).length : by(k).length]));
    const filters = FILTERS.filter(([k]) => k === 'all' || k === 'active' || k === 'inactive' || counts[k] > 0);
    if (!filters.some(f => f[0] === ui.filter)) ui.filter = 'all';
    const q = ui.q.trim().toLowerCase();
    const shown = members.filter(u => inFilter(u) && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(membershipOf(b) === 'applied') - Number(membershipOf(a) === 'applied') || compareMembers(a, b));

    // Umpiring: from this season's availability (Available to at least one date = Active umpire).
    const umpiringCell = u => {
      if (membershipOf(u) !== 'member') return h('span', { class: 'muted' }, '\u2014');
      const on = statusOf(u) === 'active';
      return h('span', { class: 'chip ' + (on ? 'ok' : 'muted-chip'), title: on ? 'Available to at least one date this season' : 'No date marked Available this season' }, on ? 'Active umpire' : 'Inactive member');
    };
    // Membership: where they stand.
    const membershipCell = u => {
      const m = membershipOf(u);
      return h('span', { class: 'chip ' + MEMBERSHIP_CHIP[m] }, MEMBERSHIP_LABEL[m]);
    };
    const search = h('input', { type: 'search', class: 'member-search', placeholder: 'Search by name or email', value: ui.q, 'aria-label': 'Search members' });
    search.oninput = () => { ui.q = search.value; draw(); const s2 = wrap.querySelector('.member-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } };
    const COLS = ['Name', 'Umpiring', 'Membership', 'Membership type'];
    // People who have asked to join, with the details they gave (the list below keeps those off the page).
    const requests = members.filter(u => membershipOf(u) === 'applied').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || compareMembers(a, b));
    const needApproval = joinSettings(store.org).membershipRequired;
    const asked = joinFieldsFor(store.org);
    const detail = (u, f) => (f.key === 'dob' && u.dob ? new Date(`${u.dob}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : u[f.key]);
    const requestsCard = () => h('section', { class: 'card join-requests' },
      h('h2', {}, `Join requests (${requests.length})`),
      h('ul', { class: 'plain request-list' }, requests.map(u => h('li', { class: 'request', 'data-pid': u.pid },
        h('div', { class: 'request-main' },
          h('div', {}, profileLink(u), u.createdAt && h('span', { class: 'muted small' }, ` \u00b7 asked ${new Date(u.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`)),
          h('div', { class: 'muted small' }, u.email),
          h('dl', { class: 'request-details' }, asked.map(f => [h('dt', {}, f.label), h('dd', {}, detail(u, f) || h('span', { class: 'muted' }, '\u2014'))]))),
        h('div', { class: 'request-actions' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => change([u], 'approve') }, 'Approve'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => change([u], 'reject') }, 'Reject'))))));
    setChildren(wrap,
      h('h1', {}, 'Members'),
      h('p', { class: 'muted' }, 'Active umpires are members who said Available to at least one date this season. Everyone else (no answer, or Not available to everything) is an Inactive member, kept for your communications. It follows their availability by itself.'),
      requests.length > 0 && requestsCard(),
      h('p', { class: 'member-mail' }, emailBtn('Email active members', active), ' ', emailBtn('Email inactive members', inactive)),
      h('section', { class: 'card' },
        h('div', { class: 'member-tools' }, search,
          h('select', { 'aria-label': 'Show', onchange: e => { ui.filter = e.target.value; draw(); } },
            filters.map(([k, label]) => h('option', { value: k, selected: ui.filter === k }, `${label} (${counts[k]})`)))),
        shown.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'board members' },        // stacks into cards on a phone
          h('thead', {}, h('tr', {}, COLS.map(c => h('th', {}, c)))),
          h('tbody', {}, shown.map(u => { const st = statusOf(u); return h('tr', { class: st === 'applied' ? 'needs' : st === 'active' ? '' : 'inactive', 'data-pid': u.pid },
            h('td', {}, profileLink(u)),
            h('td', {}, umpiringCell(u)),
            h('td', {}, membershipCell(u)),
            h('td', {}, ['member', 'suspended'].includes(membershipOf(u)) ? membershipTypeCell(u) : '')); }))))
          : h('p', { class: 'muted' }, members.length ? 'No one matches.' : 'No members yet. Bring in your membership list below, or send people the link from Settings so they can apply.')),
      addMemberCard(),
      h('details', { class: 'card import-card', open: ui.importOpen || !members.length, ontoggle: e => { ui.importOpen = e.currentTarget.open; } },
        h('summary', {}, 'Bring in your membership list'),
        h('p', { class: 'muted' }, 'Availability files are brought in on the Availabilities page, one for each group.'),
        membershipImport()));
  };
  draw();
  return wrap;
}
