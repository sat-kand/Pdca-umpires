// Screens for the appointments officer.

import { h, toast, setChildren, busy, copyText, mapsLink, todayLocal } from './ui.js';
import {
  fmtDay, fmtRange, gradeShort, compareGrades, groupSections, allocFor, buildBusyMap, assignmentWarnings,
  slotOptions, recount, summarise, formatSummary, seasonLoads, autoAllocate, applyChanges, umpireText, slotCount, isPicked, newPid, emailKey,
  availStatus, compLabel, compKeyOf, roundColumns, COMPS,
} from './logic.js';
import { syncFromPlayCricket, refreshRound, currentRound, visibleRounds, needsSync, TILE_ORDER } from './rounds.js';

const SLOT_CHOICES = [[1, '1 umpire'], [2, '2 umpires']];

const roundHeading = r => `${r.comp ? compLabel(r.comp) + ' · ' : ''}${r.title}`;

function tabs(rid, active) {
  const t = [['', 'Allocate'], ['/availability', 'Availability'], ['/report', 'Report & email']];
  return h('nav', { class: 'tabs noprint' }, t.map(([p, label]) =>
    h('a', { class: 'tab' + (active === p ? ' active' : ''), href: `#/admin/round/${rid}${p}` }, label)),
  h('a', { class: 'tab right', href: '#/admin' }, '← All rounds'));
}

// ---------------------------------------------------------------------------
// Rounds: one tile per competition showing its next round
// ---------------------------------------------------------------------------

// "Select grades" popup: tick the grades the committee wants umpires for. Only ticked grades are
// listed on the board, and the slot totals follow. `onDone` runs after saving.
async function openGradesModal({ store, round, onDone }) {
  const [games, settings] = await Promise.all([store.listGames(round.id), store.getSettings()]);
  const live = games.filter(g => !g.removed && compKeyOf(g) === (round.comp || 'senior'));
  const grades = [...new Set(live.map(g => g.grade))].sort(compareGrades);
  const count = gr => live.filter(g => g.grade === gr).length;
  const perGame = g => ((g.slots || 0) || 1);                                          // umpires per game: what the board has, else 1
  const want = Object.fromEntries(grades.map(gr => [gr, live.some(g => g.grade === gr && isPicked(g))]));
  const typeOf = gr => formatSummary(live.filter(g => g.grade === gr));              // Play Cricket's match type: One Day / Two Day / T20

  const dlg = h('dialog', { class: 'modal', 'aria-label': 'Select grades' });
  const total = h('span', { class: 'muted' });
  const rows = grades.map(gr => {
    const cb = h('input', { type: 'checkbox', checked: want[gr], id: 'g-' + gr.replace(/\W+/g, '_') });
    cb.onchange = () => { want[gr] = cb.checked; showTotal(); };
    return { gr, cb, row: h('label', { class: 'grade-row' }, cb, h('span', { class: 'chip grade' }, gradeShort(gr)), h('span', { class: 'muted' }, `${count(gr)} game${count(gr) === 1 ? '' : 's'}`),
      h('span', { class: 'muted' }, typeOf(gr))) };
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
      const n = g.removed || !(g.grade in want) || compKeyOf(g) !== (round.comp || 'senior') ? (g.slots || 0) : (want[g.grade] ? perGame(g) : 0);
      if (n !== (g.slots || 0)) { g.slots = n; changed.push({ ...g, slots: n }); }
    }
    if (changed.length) await store.saveGames(round.id, changed);
    await store.saveRound({ id: round.id, ...summarise(games) });
    Object.assign(round, summarise(games));
    const slotsByGrade = { ...(settings.slotsByGrade || {}) };
    for (const gr of grades) slotsByGrade[gr] = want[gr] ? Math.max(...live.filter(g => g.grade === gr).map(perGame)) : 0;   // remembered for the next round
    await store.saveSettings({ slotsByGrade });
    dlg.close(); dlg.remove();
    if (onDone) await onDone();
  });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel');
  dlg.append(
    h('h2', {}, `${compLabel(round.comp || 'senior')} · ${round.title}`),
    h('p', { class: 'muted' }, 'Tick the grades that need umpires.'),
    h('div', { class: 'row-between' }, total, h('span', {}, h('button', { class: 'link', type: 'button', onclick: () => setAll(true) }, 'All'), ' · ', h('button', { class: 'link', type: 'button', onclick: () => setAll(false) }, 'None'))),
    h('div', { class: 'grade-list' }, rows.map(r => r.row), !grades.length && h('p', { class: 'muted' }, 'No games in this round.')),
    h('div', { class: 'modal-actions' }, cancel, done));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  showTotal();
  dlg.showModal();
}

export async function viewAdminHome(ctx) {
  const { store } = ctx;
  const today = todayLocal();
  const wrap = h('div');
  const state = { rounds: [], season: null, syncing: false, error: '', more: 0 };

  async function load() { [state.rounds, state.season] = await Promise.all([store.listRounds(), store.getSeason()]); }

  const empty = c => h('div', { class: 'card comp-tile empty' }, h('h2', {}, c.label), h('p', { class: 'muted' }, state.syncing ? 'Loading fixtures…' : 'No upcoming games'));

  function tile(r) {
    const c = COMPS.find(x => x.key === r.comp) || { label: compLabel(r.comp) };
    const st = r.stats || { needed: 0, filled: 0 };
    const picked = r.picked || 0;
    return h('div', { class: 'card comp-tile' },
      h('div', { class: 'row-between' }, h('h2', {}, c.label),
        h('button', { class: 'btn small', type: 'button', onclick: () => openGradesModal({ store, round: r, onDone: async () => { await load(); draw(); } }) }, 'Select grades')),
      h('a', { class: 'tile-body', href: `#/admin/round/${r.id}` },
        h('div', { class: 'tile-round' }, fmtRange(r.dates || [])),
        h('div', { class: 'muted' }, r.formats || ''),
        h('div', { class: 'tile-stats' },
          h('span', { class: 'chip' }, `${picked} grade${picked === 1 ? '' : 's'}`),
          h('span', { class: 'chip ' + (st.needed && st.filled >= st.needed ? 'ok' : 'warn') }, `${st.filled}/${st.needed} slots filled`),
          r.published && h('span', { class: 'chip ok' }, 'Published'))));
  }

  function draw() {
    const shown = visibleRounds(state.rounds, today, state.more);
    setChildren(wrap,
      h('div', { class: 'row-between' }, h('h1', {}, 'Rounds'), state.syncing && h('span', { class: 'muted' }, 'Updating fixtures from Play Cricket…')),
      state.error && h('p', { class: 'notice warn' }, state.error, ' ', h('button', { class: 'link', type: 'button', onclick: () => sync(true) }, 'Try again')),
      shown.sets.map((set, i) => [i > 0 && h('hr', { class: 'set-break' }), h('div', { class: 'cards' }, set.map(tile))]),
      COMPS.some(c => !currentRound(state.rounds, c.key, today)) && h('div', { class: 'cards' }, [...COMPS].sort((a, b) => TILE_ORDER.indexOf(a.key) - TILE_ORDER.indexOf(b.key)).filter(c => !currentRound(state.rounds, c.key, today)).map(empty)),
      shown.hasMore && h('div', { class: 'load-more' }, h('button', { class: 'btn', type: 'button', onclick: () => { state.more++; draw(); } }, 'Load more')));
  }

  async function sync(force) {
    if (state.syncing) return;
    state.syncing = true; state.error = ''; draw();
    try { await syncFromPlayCricket(store, { today }); await load(); }
    catch (e) { console.error(e); state.error = `Could not load the fixtures from Play Cricket (${e.message || e}).`; }
    state.syncing = false; draw();
  }

  await load();
  draw();
  // First visit, or fixtures more than half a day old, or a competition has no round yet: fetch in the background.
  if (needsSync(state.season, state.rounds, today)) sync();
  return wrap;
}

// ---------------------------------------------------------------------------
// Allocation board
// ---------------------------------------------------------------------------

export async function viewBoard(ctx, rid) {
  const { store } = ctx;
  const round = await store.getRound(rid);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  const [games, umpires, availList, rounds, settings] = await Promise.all([
    store.listGames(rid), store.listUmpires(), store.listAvailability((round.season && round.season.id) || 'manual'), store.listRounds(), store.getSettings(),
  ]);
  const B = { ui: { grades: false, warns: false }, round, games, umpires, settings, availByEmail: Object.fromEntries(availList.map(a => [a.email, a])) };
  const otherStats = rounds.filter(r => r.id !== rid && r.season && round.season && r.season.id === round.season.id).map(r => r.stats);
  const wrap = h('div');

  const persistStats = async () => { Object.assign(B.round, summarise(B.games)); await store.saveRound({ id: rid, ...summarise(B.games) }); };
  // Only the grades the officer picked are listed; the rest of the competition stays out of the way.
  const visible = () => B.games.filter(isPicked);
  const draw = () => { const y = window.scrollY; setChildren(wrap, build()); window.scrollTo(0, y); };
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); draw(); } };

  async function writeGame(g, patch) {
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

  // Active umpires who have not answered for any date of this round.
  const noReply = () => { const cols = roundColumns(visible()); return B.umpires.filter(u => u.active && cols.every(c => availStatus(B.availByEmail, u, c.comp, c.date) === 'none')); };

  function collectWarnings() {
    const busy = buildBusyMap(B.games), out = [];
    for (const g of visible()) {
      if (g.removed) continue;
      for (const d of g.days) {
        allocFor(g, d.date).forEach((a, i) => {
          if (!a) return;
          const u = B.umpires.find(x => x.pid === a.p);
          if (!u) { out.push({ g, d, text: `${a.n}: umpire not found in the umpire list` }); return; }
          const w = assignmentWarnings({ game: g, date: d.date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy });
          if (w.length) out.push({ g, d, text: `${u.name}: ${w.join('; ')}` });
        });
      }
    }
    return out;
  }

  function slotSelect(g, date, i, busyMap, loads) {
    const cur = allocFor(g, date)[i];
    const opts = slotOptions({ game: g, date, slotIndex: i, umpires: B.umpires, availByEmail: B.availByEmail, busy: busyMap, loads });
    const multi = g.days.length > 1;
    // Two-day games: umpires free on every day come first, so one pick can cover both days.
    const GROUPS = multi
      ? [['both', 'Available both days'], ['ok', 'Available this day only'], ['none', 'No response yet'], ['avoid', 'Unavailable or already busy']]
      : [['ok', 'Available'], ['none', 'No response yet'], ['avoid', 'Unavailable or already busy']];
    const label = o => `${o.umpire.name}${o.load ? ` · ${o.load}` : ''}${o.busy ? ' · busy' : ''}`;
    const sel = h('select', { class: 'slot' + (cur ? '' : ' empty'), 'aria-label': `Umpire ${i + 1}, ${gradeShort(g.grade)} ${g.home.name}, ${fmtDay(date)}`,
      onchange: guard(async () => {
        const u = B.umpires.find(x => x.pid === sel.value);
        if (!u) { await setAlloc(g, date, i, null); return; }
        // Picking someone for Day 1 of a two-day game also fills the empty later days when that
        // umpire is free and clean there. Day 2 can still be changed on its own.
        const alloc = structuredClone(g.alloc || {});
        const put = (dt) => { const arr = (alloc[dt] ||= []); while (arr.length <= i) arr.push(null); arr[i] = { p: u.pid, n: u.name }; };
        put(date);
        let extra = 0;
        const cleanPick = !assignmentWarnings({ game: g, date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy: busyMap }).length;
        if (cleanPick && g.days.length > 1 && date === g.days[0].date) {
          for (const d of g.days.slice(1)) {
            if (allocFor(g, d.date)[i]) continue;
            if (!assignmentWarnings({ game: g, date: d.date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy: busyMap }).length) { put(d.date); extra++; }
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
      return u ? assignmentWarnings({ game: g, date, slotIndex: i, umpire: u, availByEmail: B.availByEmail, busy: busyMap }) : ['Umpire not in list'];
    })() : [];
    return h('div', { class: 'slot-wrap' }, sel, warn.length > 0 && h('span', { class: 'warn-icon', title: warn.join('\n'), tabindex: 0 }, '⚠'));
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
      h('td', {}, g.removed ? h('span', { class: 'chip warn' }, 'removed') : h('select', { class: 'n-slots', 'aria-label': 'Umpires needed', value: String(n),
        onchange: guard(async e => { await writeGame(g, { slots: Number(e.target.value) }); draw(); }) },
      SLOT_CHOICES.map(([v, l]) => h('option', { value: String(v) }, l)))),
      h('td', {}, n ? g.days.map(d => h('div', { class: 'day-block' },
        g.days.length > 1 && h('div', { class: 'day-label' }, `Day ${d.day} · ${fmtDay(d.date)}`),
        Array.from({ length: n }, (_, i) => slotSelect(g, d.date, i, busyMap, loads)))) : h('span', { class: 'muted' }, 'No umpire needed')));
  }

  async function doUpdateFixtures() {
    const res = await refreshRound(store, B.round, B.settings);
    if (!res) { toast('This sample round has no live fixture source.'); return; }
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

    const toggle = (label, field, hint, confirmFn) => {
      const cb = h('input', { type: 'checkbox', checked: !!B.round[field], onchange: guard(async () => {
        if (cb.checked && confirmFn && !confirm(confirmFn())) { cb.checked = false; return; }
        B.round[field] = cb.checked; await store.saveRound({ id: rid, [field]: cb.checked });
        toast(`${label}: ${cb.checked ? 'on' : 'off'}`);
      }) });
      return h('label', { class: 'toggle' }, cb, h('span', {}, h('strong', {}, label), h('small', { class: 'muted' }, hint)));
    };

    const gradesBtn = h('button', { class: 'btn', type: 'button', onclick: () => openGradesModal({ store, round: B.round, onDone: async () => { B.games = await store.listGames(rid); B.settings = await store.getSettings(); B.round = await store.getRound(rid); draw(); } }) }, 'Select grades');

    const autoBtn = h('button', { class: 'btn', type: 'button' }, '✨ Suggest allocations');
    autoBtn.onclick = busy(autoBtn, guard(async () => {
      const changes = autoAllocate({ games: B.games, umpires: B.umpires, availByEmail: B.availByEmail, baseLoads: seasonLoads(otherStats) });
      if (!changes.length) { toast('No empty slots could be filled with umpires who said "Available".'); return; }
      if (!confirm(`Fill ${changes.length} empty slot(s) using only umpires who said "Available"? Existing allocations are not touched.`)) return;
      const ids = new Set(changes.map(c => c.gameId));
      const updated = [];
      for (const g of B.games) if (ids.has(g.id)) { g.alloc = applyChanges(g, changes); updated.push(g); }
      await store.saveGames(rid, updated);
      await persistStats(); draw();
      toast(`Filled ${changes.length} slot(s). Please review before publishing.`);
    }));
    const updBtn = h('button', { class: 'btn', type: 'button' }, '↻ Update fixtures');
    updBtn.onclick = busy(updBtn, guard(doUpdateFixtures));
    const clearBtn = h('button', { class: 'btn danger', type: 'button' }, 'Clear all');
    clearBtn.onclick = guard(async () => {
      if (!confirm('Remove every umpire allocation in this round?')) return;
      const all = B.games.map(g => ({ ...g, alloc: {} }));
      await store.saveGames(rid, all); all.forEach((x, i) => { B.games[i].alloc = {}; });
      await persistStats(); draw();
    });
    return [
      h('div', { class: 'row-between' }, h('h1', {}, roundHeading(B.round)), h('span', { class: 'muted' }, fmtRange(B.round.dates))),
      tabs(rid, ''),
      h('div', { class: 'card toolbar' },
        h('div', { class: 'toggles' },
          toggle('Published', 'published', 'Umpires can see their allocations', () => st.filled < st.needed ? `${st.needed - st.filled} slot(s) are still empty. Publish anyway?` : 'Publish allocations to umpires?')),
        h('div', { class: 'actions' }, gradesBtn, autoBtn, updBtn, clearBtn)),
      h('div', { class: 'summary' },
        h('span', { class: 'chip ' + (st.needed && st.filled === st.needed ? 'ok' : 'warn') }, `${st.filled} of ${st.needed} slots filled`),
        h('span', { class: 'chip ' + (warnings.length ? 'warn' : 'ok') }, warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : 'No warnings'),
        noReply().length > 0 && h('span', { class: 'chip' }, `${noReply().length} umpires haven't replied`)),
      warnings.length > 0 && h('details', { class: 'card', open: B.ui.warns, ontoggle: e => { B.ui.warns = e.target.open; } }, h('summary', {}, 'Show warnings'),
        h('ul', {}, warnings.map(w => h('li', {}, `${gradeShort(w.g.grade)} ${w.g.home.name} v ${w.g.away.name}, ${fmtDay(w.d.date)} — ${w.text}`)))),
      sections.map(s => h('section', { class: 'card' },
        h('h2', {}, `${s.label} – ${fmtRange(s.dates)}`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
          h('thead', {}, h('tr', {}, ['Grade', 'Fixture', 'Ground', 'Umpires', 'Allocation'].map(c => h('th', {}, c)))),
          h('tbody', {}, s.games.map(g => gameRow(g, busyMap, loads))))))),
      !sections.length && h('p', { class: 'muted' }, 'No grades selected yet. Press Select grades to choose the grades that need umpires.'),
      h('p', { class: 'muted' }, 'Numbers next to a name are that umpire\'s appointments so far this season; "busy" means they are already on another game that day.'),
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
  const [umpires, availList, allGames] = await Promise.all([store.listUmpires(), store.listAvailability((round.season && round.season.id) || 'manual'), store.listGames(rid)]);
  const games = allGames.filter(isPicked);
  const by = Object.fromEntries(availList.map(a => [a.email, a]));
  const active = umpires.filter(u => u.active).sort((a, b) => a.name.localeCompare(b.name));
  const cols = roundColumns(games);
  const multi = new Set(cols.map(c => c.comp)).size > 1;
  const colName = c => (multi ? `${compLabel(c.comp)} · ` : '') + fmtDay(c.date);
  const missing = active.filter(u => cols.every(c => availStatus(by, u, c.comp, c.date) === 'none'));
  const ICON = { yes: ['✓', 'ok'], no: ['✗', 'no'], none: ['–', 'none'] };
  const counts = c => { const n = { yes: 0, no: 0, none: 0 }; active.forEach(u => { n[availStatus(by, u, c.comp, c.date)]++; }); return n; };
  const emails = missing.map(u => u.email);

  return h('div', {},
    h('div', { class: 'row-between' }, h('h1', {}, roundHeading(round)), h('span', { class: 'muted' }, fmtRange(round.dates))),
    tabs(rid, '/availability'),
    h('div', { class: 'card' },
      h('div', { class: 'summary' }, cols.map(c => { const n = counts(c); return h('span', { class: 'chip' }, `${colName(c)}: ${n.yes} available · ${n.no} not available · ${n.none} no reply`); })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Umpire'), cols.map(c => h('th', {}, colName(c))), h('th', {}, ''))),
        h('tbody', {}, active.map(u => h('tr', {}, h('td', {}, u.name),
          cols.map(c => { const [t, k] = ICON[availStatus(by, u, c.comp, c.date)]; return h('td', { class: 'av ' + k }, t); }),
          h('td', {}))))))),
    h('div', { class: 'card' }, h('h2', {}, `Haven't replied (${missing.length})`),
      missing.length ? [h('p', {}, missing.map(u => u.name).join(', ')),
        h('button', { class: 'btn', type: 'button', onclick: async () => { toast(await copyText(emails.join(', ')) ? 'Emails copied' : 'Could not copy', 'ok'); } }, 'Copy their emails'), ' ',
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
    return h('div', {}, h('h1', {}, 'Availability'), h('p', { class: 'notice' }, 'No season dates yet. They load from Play Cricket when you open Rounds.'));
  }
  const [umpires, availList] = await Promise.all([store.listUmpires(), store.listAvailability(season.id || 'manual')]);
  const by = Object.fromEntries(availList.map(a => [a.email, a]));
  const active = umpires.filter(u => u.active).sort((a, b) => a.name.localeCompare(b.name));
  const comps = [...COMPS].sort((a, b) => TILE_ORDER.indexOf(a.key) - TILE_ORDER.indexOf(b.key)).filter(c => season.calendar.some(e => (e.comp || 'senior') === c.key));
  const wrap = h('div');
  const ui = { comp: comps[0].key };

  // One cell: the days of a round an umpire can do, or Not Available / blank.
  function cell(u, comp, dates, rounds) {
    const st = dates.map(d => availStatus(by, u, comp, d));
    const yes = st.filter(x => x === 'yes').length;
    if (!yes) return st.includes('no') ? ['Not Available', 'no'] : ['', 'none'];
    if (!rounds) return ['Yes', 'ok'];
    if (dates.length === 1) return ['Yes', 'ok'];
    return [dates.map((d, i) => (st[i] === 'yes' ? `Day ${i + 1}` : null)).filter(Boolean).join(', '), yes === dates.length ? 'ok' : 'part'];
  }

  function build() {
    const entries = season.calendar.filter(e => (e.comp || 'senior') === ui.comp);
    const rounds = entries.some(e => e.label);                                   // rounds layout, else a plain list of dates
    const cols = rounds ? entries.map(e => ({ title: e.label, sub: fmtRange(e.dates), dates: e.dates }))
      : entries.flatMap(e => e.dates).sort().map(d => ({ title: fmtDay(d), sub: '', dates: [d] }));
    cols.forEach(c => { c.past = c.dates[c.dates.length - 1] < today; });
    const answered = u => (by[u.email] && by[u.email].days && Object.keys(by[u.email].days).some(k => k.startsWith(ui.comp + ':')));
    const missing = active.filter(u => !answered(u));
    const emails = missing.map(u => u.email);
    const count = c => active.filter(u => c.dates.some(d => availStatus(by, u, ui.comp, d) === 'yes')).length;

    return [
      h('div', { class: 'row-between' }, h('h1', {}, 'Availability'), h('span', { class: 'muted' }, season.name || '')),
      h('nav', { class: 'tabs noprint' }, comps.map(c => h('button', { class: 'tab' + (c.key === ui.comp ? ' active' : ''), type: 'button', onclick: () => { ui.comp = c.key; setChildren(wrap, build()); } }, c.label))),
      h('div', { class: 'card' },
        h('div', { class: 'summary' },
          h('span', { class: 'chip' }, `${active.length} umpires`),
          h('span', { class: 'chip ok' }, `${active.length - missing.length} have answered`),
          h('span', { class: 'chip ' + (missing.length ? 'warn' : 'ok') }, `${missing.length} not yet`),
          missing.length > 0 && h('button', { class: 'btn small', type: 'button', onclick: async () => { toast(await copyText(emails.join(', ')) ? 'Emails copied' : 'Could not copy', 'ok'); } }, 'Copy emails of those not answered')),
        h('div', { class: 'table-wrap season-grid' }, h('table', { class: 'board' },
          h('thead', {},
            h('tr', {}, h('th', { class: 'stick' }, 'Name'), cols.map(c => h('th', { class: c.past ? 'past' : '' }, h('div', {}, c.title), c.sub && h('div', { class: 'sub' }, c.sub)))),
            h('tr', { class: 'counts' }, h('td', { class: 'stick' }, 'Available'), cols.map(c => h('td', { class: 'av ' + (c.past ? 'past' : '') }, String(count(c)))))),
          h('tbody', {}, active.map(u => h('tr', {}, h('td', { class: 'stick' }, u.name),
            cols.map(c => { const [t, k] = cell(u, ui.comp, c.dates, rounds); return h('td', { class: 'av ' + k + (c.past ? ' past' : '') }, t); }))))))),
    ];
  }
  setChildren(wrap, build());
  return wrap;
}

// ---------------------------------------------------------------------------
// Report + email
// ---------------------------------------------------------------------------

export function reportText(round, sections) {
  const out = [round.title, ''];
  for (const s of sections) {
    out.push(`${s.label} – ${fmtRange(s.dates)}`);
    for (const g of s.games) if (!g.removed) out.push(`${gradeShort(g.grade)} | ${g.home.name} v ${g.away.name} | ${g.ground} | ${umpireText(g)}`);
    out.push('');
  }
  return out.join('\n');
}

export async function viewReport(ctx, rid) {
  const { store } = ctx;
  const [round, games, umpires] = await Promise.all([store.getRound(rid), store.listGames(rid), store.listUmpires()]);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  const sections = groupSections(games.filter(g => !g.removed && isPicked(g)));
  const st = recount(games);
  const pids = new Set(st.byUmpire ? Object.keys(st.byUmpire) : []);
  const emails = umpires.filter(u => pids.has(u.pid)).map(u => u.email);
  const subject = `Umpire allocations: ${round.title}`;
  const link = location.origin + location.pathname;
  const body = `Hi all,\n\nUmpire allocations for ${round.title} are attached/below.\n\nYou can also see your own appointments at ${link}\n\nThanks`;

  const print = h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, 'Print / Save as PDF');
  const copyEmails = h('button', { class: 'btn', type: 'button', onclick: async () => toast((await copyText(emails.join(', '))) ? `${emails.length} email addresses copied` : 'Could not copy', 'ok') }, `Copy umpire emails (${emails.length})`);
  const copyTable = h('button', { class: 'btn', type: 'button', onclick: async () => toast((await copyText(reportText(round, sections))) ? 'Report text copied' : 'Could not copy', 'ok') }, 'Copy report as text');
  const draft = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const url = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (url.length > 1900) { await copyText(emails.join(', ')); toast('Too many addresses for a draft, so the emails were copied. Paste them into BCC.'); location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }
    else location.href = url;
  } }, 'Open email draft');

  return h('div', {},
    h('div', { class: 'row-between noprint' }, h('h1', {}, roundHeading(round)), h('span', { class: 'muted' }, fmtRange(round.dates))),
    tabs(rid, '/report'),
    h('div', { class: 'card noprint' },
      st.filled < st.needed && h('p', { class: 'notice warn' }, `${st.needed - st.filled} slot(s) are still unallocated and show as "—" on the report.`),
      !round.published && h('p', { class: 'notice' }, 'This round is not published yet, so umpires cannot see it in the app. Publish it from the Allocate tab.'),
      h('p', {}, print, ' ', copyTable, ' ', copyEmails, ' ', draft),
      h('p', { class: 'muted' }, 'Tip: choose "Save as PDF" in the print dialog, then attach the PDF to the email.')),
    h('div', { class: 'report' }, sections.map(s => h('section', { class: 'report-section' },
      h('h2', {}, `${s.label} – ${fmtRange(s.dates)}`),
      h('table', { class: 'report-table' },
        h('thead', {}, h('tr', {}, ['', 'HOME TEAM', 'AWAY TEAM', 'GROUND', 'UMPIRES'].map(c => h('th', {}, c)))),
        h('tbody', {}, s.games.map(g => h('tr', {}, h('td', {}, gradeShort(g.grade)), h('td', {}, g.home.name.toUpperCase()), h('td', {}, g.away.name.toUpperCase()),
          h('td', {}, g.ground.toUpperCase()), h('td', { class: slotCount(g) && /—/.test(umpireText(g)) ? 'gap' : '' }, umpireText(g))))))))));
}

// ---------------------------------------------------------------------------
// Umpire list
// ---------------------------------------------------------------------------

export async function viewUmpires(ctx) {
  const { store } = ctx;
  let umpires = await store.listUmpires();
  const wrap = h('div');
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); } };

  const draw = () => {
    umpires.sort((a, b) => Number(a.active) - Number(b.active) || a.name.localeCompare(b.name));
    const save = (u, patch) => guard(async () => { Object.assign(u, patch); await store.saveUmpire({ ...u, updatedAt: new Date().toISOString() }); draw(); })();
    const field = (u, key, ph = '') => h('input', { value: u[key] || '', placeholder: ph, onchange: e => save(u, { [key]: e.target.value.trim() }) });
    const add = h('textarea', { rows: 5, placeholder: 'One umpire per line:\nName, email, mobile (optional)\nJ Smith, j.smith@example.com, 0400 000 000' });
    const addBtn = h('button', { class: 'btn primary', type: 'button' }, 'Add umpires');
    addBtn.onclick = busy(addBtn, async () => {
      const lines = add.value.split('\n').map(l => l.trim()).filter(Boolean);
      let added = 0; const bad = [];
      for (const line of lines) {
        const [name, email, phone = ''] = line.split(/[,\t]/).map(s => s.trim());
        const key = emailKey(email);
        if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) { bad.push(line); continue; }
        if (umpires.some(u => u.email === key)) continue;
        const u = { pid: newPid(), email: key, name, phone, active: true, updatedAt: new Date().toISOString() };
        await store.saveUmpire(u); umpires.push(u); added++;
      }
      toast(`${added} umpire(s) added${bad.length ? `; couldn't read ${bad.length} line(s)` : ''}`, bad.length ? 'err' : 'ok');
      draw();
    });
    const pending = umpires.filter(u => !u.active);
    setChildren(wrap,
      h('div', { class: 'row-between' }, h('h1', {}, 'Umpires'), h('a', { class: 'btn', href: '#/admin' }, '← Rounds')),
      pending.length > 0 && h('p', { class: 'notice warn' }, `${pending.length} umpire(s) are waiting for approval. Tick "Active" to approve them.`),
      h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, ['Active', 'Name', 'Email', 'Mobile'].map(c => h('th', {}, c)))),
        h('tbody', {}, umpires.map(u => h('tr', { class: u.active ? '' : 'needs' },
          h('td', {}, h('input', { type: 'checkbox', checked: !!u.active, 'aria-label': 'Active', onchange: e => save(u, { active: e.target.checked }) })),
          h('td', {}, field(u, 'name')), h('td', { class: 'muted' }, u.email), h('td', {}, field(u, 'phone'))))))),
      !umpires.length && h('p', { class: 'muted' }, 'No umpires yet. Add some below, or ask them to sign in and fill in their details.')),
      h('div', { class: 'card' }, h('h2', {}, 'Add umpires'), h('p', { class: 'muted' }, 'Paste your existing list (for example from the Google Form responses). Added umpires are active straight away and can sign in with that email address.'), add, addBtn));
  };
  draw();
  return wrap;
}
