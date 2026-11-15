// Screens for the appointments officer.

import { CONFIG } from './config.js';
import { h, toast, setChildren, busy, copyText, mapsLink } from './ui.js';
import {
  fmtDay, fmtRange, gradeShort, compareGrades, groupSections, sectionKey, allocFor, buildBusyMap, assignmentWarnings,
  slotOptions, recount, seasonLoads, autoAllocate, applyChanges, umpireText, slotCount, newPid, emailKey, availStatus, buildCalendar,
} from './logic.js';
import { makeApi, fetchSeasons, fetchCompetitions, loadFixtures, gamesFromCsv, mergeFixtures } from './fixtures.js';

const SLOT_CHOICES = [[0, 'None'], [1, '1 umpire'], [2, '2 umpires']];

function tabs(rid, active) {
  const t = [['', 'Allocate'], ['/availability', 'Availability'], ['/report', 'Report & email']];
  return h('nav', { class: 'tabs noprint' }, t.map(([p, label]) =>
    h('a', { class: 'tab' + (active === p ? ' active' : ''), href: `#/admin/round/${rid}${p}` }, label)),
  h('a', { class: 'tab right', href: '#/admin' }, '← All rounds'));
}

function defaultSlotsFn(settings) { return g => (settings.slotsByGrade && settings.slotsByGrade[g.grade] != null ? settings.slotsByGrade[g.grade] : 1); }

// ---------------------------------------------------------------------------
// Rounds list
// ---------------------------------------------------------------------------

// Pull the whole season's fixtures and turn them into the date list umpires answer for.
async function syncSeason(store) {
  const api = makeApi(CONFIG.apiBase);
  const seasons = await fetchSeasons(api, CONFIG.orgId);
  const cur = seasons.find(x => x.current) || seasons[0];
  if (!cur) throw new Error('No season found on Play Cricket');
  const comps = await fetchCompetitions(api, CONFIG.orgId, cur.id);
  const senior = comps.filter(c => /senior/i.test(c.name));
  const games = await loadFixtures({ api, comps: senior.length ? senior : comps.filter(c => !/junior/i.test(c.name)), from: '0000-01-01', to: '9999-12-31' });
  const season = { id: cur.id, name: cur.name, calendar: buildCalendar(games), updatedAt: new Date().toISOString() };
  await store.saveSeason(season);
  return season;
}

export async function viewAdminHome(ctx) {
  const [rounds, season] = await Promise.all([ctx.store.listRounds(), ctx.store.getSeason()]);
  const nDates = season ? season.calendar.reduce((n, r) => n + r.dates.length, 0) : 0;
  const syncBtn = h('button', { class: 'btn', type: 'button' }, season ? '↻ Re-sync dates' : 'Set up season dates');
  syncBtn.onclick = busy(syncBtn, async () => {
    const x = await syncSeason(ctx.store);
    toast(`Season dates saved: ${x.calendar.length} rounds`);
    ctx.go('/admin');
  });
  return h('div', {},
    h('div', { class: 'row-between' }, h('h1', {}, 'Rounds'), h('a', { class: 'btn primary', href: '#/admin/new' }, '+ New round')),
    h('div', { class: 'card' },
      h('div', { class: 'row-between' },
        h('div', {}, h('strong', {}, 'Season dates'), ' ', season ? h('span', { class: 'muted' }, `${season.name} · ${season.calendar.length} rounds, ${nDates} dates · umpires answer for these`) : h('span', { class: 'chip warn' }, 'Not set up — umpires cannot give availability yet')),
        syncBtn),
      season && h('details', {}, h('summary', {}, 'Show the dates umpires see'),
        h('ul', { class: 'plain' }, season.calendar.map(r => h('li', {}, h('strong', {}, r.label), ' — ', r.dates.map(fmtDay).join(' and ')))),
        h('p', { class: 'muted' }, 'Built from the Senior competition fixtures. Re-sync if the fixture list changes.'))),
    rounds.length ? h('div', { class: 'cards' }, rounds.map(r => {
      const st = r.stats || { needed: 0, filled: 0 };
      return h('a', { class: 'card round-card', href: `#/admin/round/${r.id}` },
        h('h2', {}, r.title), h('p', { class: 'muted' }, fmtRange(r.dates || [])),
        h('div', {}, h('span', { class: 'chip ' + (st.filled >= st.needed && st.needed ? 'ok' : 'warn') }, `${st.filled}/${st.needed} slots filled`),
          r.published && h('span', { class: 'chip ok' }, 'Published')));
    })) : h('div', { class: 'card' }, h('p', {}, 'No rounds yet. Create one to import fixtures and start allocating.')));
}

// ---------------------------------------------------------------------------
// New round wizard
// ---------------------------------------------------------------------------

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const a = iso(d); d.setDate(d.getDate() + 7);
  return [a, iso(d)];
}

export async function viewNewRound(ctx) {
  const { store, go } = ctx;
  const api = makeApi(CONFIG.apiBase);
  const [from0, to0] = nextSaturday();
  const root = h('div', {});
  const previewBox = h('div');
  let seasons = [], comps = [];

  // ----- preview + create (shared by both sources)
  function showPreview(games, source, warnings = []) {
    if (!games.length) { previewBox.replaceChildren(h('p', { class: 'notice warn' }, 'No fixtures found for those dates.')); return; }
    const sections = groupSections(games);
    const checks = sections.map(s => h('input', { type: 'checkbox', checked: true, 'data-key': s.key }));
    const title = h('input', { value: `${sections[0].label} – ${fmtRange(sections[0].dates)}` });
    const create = h('button', { class: 'btn primary' }, 'Create round');
    create.onclick = busy(create, async () => {
      const keys = checks.filter(c => c.checked).map(c => c.dataset.key);
      const chosen = games.filter(g => keys.includes(sectionKey(g)));
      if (!chosen.length) { toast('Tick at least one group of fixtures', 'err'); return; }
      const settings = await store.getSettings();
      const slots = defaultSlotsFn(settings);
      const all = chosen.map(g => ({ ...g, slots: slots(g), alloc: {} }));
      const dates = [...new Set(all.flatMap(g => g.days.map(d => d.date)))].sort();
      const cur = await store.getSeason();
      const existing = new Set((await store.listRounds()).map(r => r.id));
      let id = 'r-' + dates[0], n = 2;
      while (existing.has(id)) id = `r-${dates[0]}-${n++}`;
      await store.saveRound({
        id, title: title.value.trim() || id, start: dates[0], end: dates[dates.length - 1], dates,
        season: source.seasonId ? { id: source.seasonId, name: source.seasonName } : cur ? { id: cur.id, name: cur.name } : { id: 'manual', name: 'Manual' },
        published: false, source: { ...source, sectionKeys: keys }, stats: recount(all),
        createdAt: new Date().toISOString(),
      });
      await store.saveGames(id, all);
      toast(`Round created with ${all.length} games`);
      go('/admin/round/' + id);
    });
    setChildren(previewBox,
      h('h2', {}, `Found ${games.length} games`),
      warnings.length > 0 && h('div', { class: 'notice warn' }, warnings.map(w => h('div', {}, w))),
      h('p', { class: 'muted' }, 'Tick the groups that belong in this round. Games stay linked to the fixture list, so changes to ground or time can be pulled in later.'),
      h('ul', { class: 'plain' }, sections.map((s, i) => h('li', {}, h('label', { class: 'inline' }, checks[i],
        h('strong', {}, ` ${s.label}`), ` — ${s.games.length} games, ${s.games[0].matchType}, ${fmtRange(s.dates)}`)))),
      h('label', {}, 'Round title (appears on the report)', title), create);
  }

  // ----- Play Cricket panel
  const seasonSel = h('select');
  const compBox = h('div', { class: 'checks' });
  const from = h('input', { type: 'date', value: from0 }), to = h('input', { type: 'date', value: to0 });
  const status = h('p', { class: 'muted' });
  const findBtn = h('button', { class: 'btn primary', type: 'button' }, 'Find fixtures');

  async function loadComps() {
    status.textContent = 'Loading competitions…'; compBox.replaceChildren();
    comps = await fetchCompetitions(api, CONFIG.orgId, seasonSel.value);
    compBox.replaceChildren(...comps.map(c => h('label', { class: 'inline' },
      h('input', { type: 'checkbox', value: c.id, checked: /senior/i.test(c.name) }), ` ${c.name} `, h('span', { class: 'muted' }, `(${c.grades.length} grades)`))));
    status.textContent = '';
  }
  seasonSel.onchange = () => loadComps().catch(showApiError);
  function showApiError(e) {
    status.replaceChildren(h('span', { class: 'notice err' }, `Couldn't reach Play Cricket: ${e.message}. You can use the CSV file option instead.`));
  }
  findBtn.onclick = busy(findBtn, async () => {
    const picked = [...compBox.querySelectorAll('input:checked')].map(i => i.value);
    if (!picked.length) { toast('Pick at least one competition', 'err'); return; }
    status.textContent = 'Fetching fixtures…';
    const chosen = comps.filter(c => picked.includes(c.id));
    const games = await loadFixtures({ api, comps: chosen, from: from.value, to: to.value, onProgress: (d, n) => { status.textContent = `Fetching fixtures… ${d}/${n} grades`; } });
    status.textContent = '';
    const season = seasons.find(s => s.id === seasonSel.value);
    showPreview(games, { type: 'playcricket', seasonId: season.id, seasonName: season.name, comps: picked, from: from.value, to: to.value });
  });
  const pcPanel = h('div', {},
    h('label', {}, 'Season', seasonSel), h('label', {}, 'Competitions'), compBox,
    h('div', { class: 'grid2' }, h('label', {}, 'First day from', from), h('label', {}, 'to', to)),
    h('p', { class: 'muted' }, 'Games are included when their first day falls in this window. A two-day round that starts on 10 Oct and finishes on 17 Oct is found by a window that includes 10 Oct.'),
    findBtn, status);

  // ----- CSV panel
  const file = h('input', { type: 'file', accept: '.csv,.txt,.tsv' });
  const pasted = h('textarea', { rows: 6, placeholder: 'grade,home,away,ground,date,day 2,time\nSenior A Grade,Team 1,Team 2,Some Park,10/10/2026,17/10/2026,13:30' });
  const csvBtn = h('button', { class: 'btn primary', type: 'button' }, 'Preview fixtures');
  csvBtn.onclick = busy(csvBtn, async () => {
    const text = pasted.value.trim() || (file.files[0] ? await file.files[0].text() : '');
    if (!text) { toast('Choose a file or paste the fixtures first', 'err'); return; }
    const { games, errors } = gamesFromCsv(text);
    showPreview(games, { type: 'csv' }, errors);
  });
  const csvPanel = h('div', { hidden: true },
    h('p', { class: 'muted' }, 'Columns: grade, home, away, ground, date — optionally day 2 (for two-day games), time and round. Dates can be 2026-10-10 or 10/10/2026. Excel or Google Sheets can export this as CSV.'),
    h('label', {}, 'CSV file', file), h('label', {}, 'or paste rows here', pasted), csvBtn);

  const tabPc = h('button', { class: 'tab active', type: 'button' }, 'From Play Cricket');
  const tabCsv = h('button', { class: 'tab', type: 'button' }, 'From a CSV file');
  tabPc.onclick = () => { pcPanel.hidden = false; csvPanel.hidden = true; tabPc.classList.add('active'); tabCsv.classList.remove('active'); previewBox.replaceChildren(); };
  tabCsv.onclick = () => { pcPanel.hidden = true; csvPanel.hidden = false; tabCsv.classList.add('active'); tabPc.classList.remove('active'); previewBox.replaceChildren(); };

  root.append(h('div', { class: 'card' }, h('h1', {}, 'New round'), h('nav', { class: 'tabs' }, tabPc, tabCsv), pcPanel, csvPanel, previewBox));

  try {
    seasons = await fetchSeasons(api, CONFIG.orgId);
    const cur = seasons.find(s => s.current) || seasons[0];
    seasonSel.replaceChildren(...seasons.slice(0, 8).map(s => h('option', { value: s.id, selected: s.id === cur.id }, s.name)));
    await loadComps();
  } catch (e) { showApiError(e); }
  return root;
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

  const persistStats = async () => { B.round.stats = recount(B.games); await store.saveRound({ id: rid, stats: B.round.stats }); };
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
  const noReply = () => B.umpires.filter(u => u.active && B.round.dates.every(d => availStatus(B.availByEmail, u, d) === 'none'));

  function collectWarnings() {
    const busy = buildBusyMap(B.games), out = [];
    for (const g of B.games) {
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
    const GROUPS = [['ok', 'Available'], ['maybe', 'Maybe'], ['none', 'No response yet'], ['avoid', 'Unavailable or already busy']];
    const label = o => `${o.umpire.name}${o.load ? ` · ${o.load}` : ''}${o.club ? ' · club' : ''}${o.busy ? ' · busy' : ''}`;
    const sel = h('select', { class: 'slot' + (cur ? '' : ' empty'), 'aria-label': `Umpire ${i + 1}, ${gradeShort(g.grade)} ${g.home.name}, ${fmtDay(date)}`,
      onchange: guard(async () => {
        const u = B.umpires.find(x => x.pid === sel.value);
        await setAlloc(g, date, i, u ? { p: u.pid, n: u.name } : null);
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
    const src = B.round.source || {};
    let fresh;
    if (src.type === 'playcricket') {
      const api = makeApi(CONFIG.apiBase);
      const comps = (await fetchCompetitions(api, CONFIG.orgId, src.seasonId)).filter(c => src.comps.includes(c.id));
      fresh = (await loadFixtures({ api, comps, from: src.from, to: src.to })).filter(g => (src.sectionKeys || []).includes(sectionKey(g)));
    } else if (src.type === 'csv') {
      const f = await pickFile();
      if (!f) return;
      const r = gamesFromCsv(await f.text());
      if (r.errors.length) toast(r.errors.join('\n'), 'err');
      fresh = r.games;
    } else { toast('This sample round has no live fixture source.'); return; }
    const res = mergeFixtures(B.games, fresh, defaultSlotsFn(B.settings));
    if (res.games.length) await store.saveGames(rid, res.games);
    for (const g of res.games) { const i = B.games.findIndex(x => x.id === g.id); if (i >= 0) B.games[i] = g; else B.games.push(g); }
    const dates = [...new Set(B.games.filter(g => !g.removed).flatMap(g => g.days.map(d => d.date)))].sort();
    B.round.dates = dates;
    await store.saveRound({ id: rid, dates, start: dates[0] || B.round.start, end: dates[dates.length - 1] || B.round.end, stats: recount(B.games) });
    B.round.stats = recount(B.games);
    draw();
    toast(res.games.length ? `Fixtures updated: ${res.added} new, ${res.changed} changed, ${res.removed} removed` : 'Fixtures are already up to date');
  }

  function build() {
    const loads = seasonLoads([...otherStats, recount(B.games)]);
    const busyMap = buildBusyMap(B.games);
    const st = recount(B.games);
    const warnings = collectWarnings();
    const sections = groupSections(B.games);

    const toggle = (label, field, hint, confirmFn) => {
      const cb = h('input', { type: 'checkbox', checked: !!B.round[field], onchange: guard(async () => {
        if (cb.checked && confirmFn && !confirm(confirmFn())) { cb.checked = false; return; }
        B.round[field] = cb.checked; await store.saveRound({ id: rid, [field]: cb.checked });
        toast(`${label}: ${cb.checked ? 'on' : 'off'}`);
      }) });
      return h('label', { class: 'toggle' }, cb, h('span', {}, h('strong', {}, label), h('small', { class: 'muted' }, hint)));
    };

    const gradeNames = [...new Set(B.games.map(g => g.grade))].sort(compareGrades);
    const gradePanel = h('details', { class: 'card', open: B.ui.grades, ontoggle: e => { B.ui.grades = e.target.open; } }, h('summary', {}, 'Which grades need umpires, and how many?'),
      h('p', { class: 'muted' }, 'Set what the secretary asked for. This applies to every game in the grade; you can still override a single game in the table. Your choice is remembered for next round.'),
      h('div', { class: 'grade-grid' }, gradeNames.map(gr => {
        const list = B.games.filter(g => g.grade === gr && !g.removed);
        const vals = [...new Set(list.map(g => g.slots))];
        return h('label', { class: 'inline' }, h('span', { class: 'chip grade' }, gradeShort(gr)),
          h('select', { value: vals.length === 1 ? String(vals[0]) : 'mixed', onchange: guard(async e => {
            const n = Number(e.target.value);
            const changed = list.map(g => ({ ...g, slots: n }));
            await store.saveGames(rid, changed);
            list.forEach(g => { g.slots = n; });
            B.settings = { ...B.settings, slotsByGrade: { ...(B.settings.slotsByGrade || {}), [gr]: n } };
            await store.saveSettings({ slotsByGrade: B.settings.slotsByGrade });
            await persistStats(); draw();
          }) }, vals.length > 1 && h('option', { value: 'mixed', disabled: true }, 'mixed'), SLOT_CHOICES.map(([v, l]) => h('option', { value: String(v) }, l))));
      })));

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
    const rename = h('button', { class: 'link', type: 'button', onclick: guard(async () => {
      const t = prompt('Round title', B.round.title); if (!t) return;
      B.round.title = t.trim(); await store.saveRound({ id: rid, title: B.round.title }); draw();
    }) }, 'rename');

    return [
      h('div', { class: 'row-between' }, h('h1', {}, B.round.title, ' ', rename), h('span', { class: 'muted' }, fmtRange(B.round.dates))),
      tabs(rid, ''),
      h('div', { class: 'card toolbar' },
        h('div', { class: 'toggles' },
          toggle('Published', 'published', 'Umpires can see their allocations', () => st.filled < st.needed ? `${st.needed - st.filled} slot(s) are still empty. Publish anyway?` : 'Publish allocations to umpires?')),
        h('div', { class: 'actions' }, autoBtn, updBtn, clearBtn)),
      h('div', { class: 'summary' },
        h('span', { class: 'chip ' + (st.needed && st.filled === st.needed ? 'ok' : 'warn') }, `${st.filled} of ${st.needed} slots filled`),
        h('span', { class: 'chip ' + (warnings.length ? 'warn' : 'ok') }, warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : 'No warnings'),
        noReply().length > 0 && h('span', { class: 'chip' }, `${noReply().length} umpires haven't replied`)),
      warnings.length > 0 && h('details', { class: 'card', open: B.ui.warns, ontoggle: e => { B.ui.warns = e.target.open; } }, h('summary', {}, 'Show warnings'),
        h('ul', {}, warnings.map(w => h('li', {}, `${gradeShort(w.g.grade)} ${w.g.home.name} v ${w.g.away.name}, ${fmtDay(w.d.date)} — ${w.text}`)))),
      gradePanel,
      sections.map(s => h('section', { class: 'card' },
        h('h2', {}, `${s.label} – ${fmtRange(s.dates)}`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
          h('thead', {}, h('tr', {}, ['Grade', 'Fixture', 'Ground', 'Umpires', 'Allocation'].map(c => h('th', {}, c)))),
          h('tbody', {}, s.games.map(g => gameRow(g, busyMap, loads))))))),
      !sections.length && h('p', { class: 'muted' }, 'No games in this round.'),
      h('p', { class: 'muted' }, 'Numbers next to a name are that umpire\'s appointments so far this season. "club" means they belong to one of the clubs; "busy" means they are already on another game that day.'),
    ];
  }

  draw();
  return wrap;
}

function pickFile() {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept: '.csv,.txt,.tsv' });
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}

// ---------------------------------------------------------------------------
// Availability overview
// ---------------------------------------------------------------------------

export async function viewAvailabilityOverview(ctx, rid) {
  const { store } = ctx;
  const round = await store.getRound(rid);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  const [umpires, availList] = await Promise.all([store.listUmpires(), store.listAvailability((round.season && round.season.id) || 'manual')]);
  const by = Object.fromEntries(availList.map(a => [a.email, a]));
  const active = umpires.filter(u => u.active).sort((a, b) => a.name.localeCompare(b.name));
  const missing = active.filter(u => round.dates.every(d => availStatus(by, u, d) === 'none'));
  const ICON = { yes: ['✓', 'ok'], maybe: ['?', 'maybe'], no: ['✗', 'no'], none: ['–', 'none'] };
  const counts = d => { const c = { yes: 0, maybe: 0, no: 0, none: 0 }; active.forEach(u => { c[availStatus(by, u, d)]++; }); return c; };
  const emails = missing.map(u => u.email);

  return h('div', {},
    h('div', { class: 'row-between' }, h('h1', {}, round.title), h('span', { class: 'muted' }, fmtRange(round.dates))),
    tabs(rid, '/availability'),
    h('div', { class: 'card' },
      h('div', { class: 'summary' }, round.dates.map(d => { const c = counts(d); return h('span', { class: 'chip' }, `${fmtDay(d)}: ${c.yes} available · ${c.no} not available · ${c.none} no reply`); })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Umpire'), round.dates.map(d => h('th', {}, fmtDay(d))), h('th', {}, ''))),
        h('tbody', {}, active.map(u => h('tr', {}, h('td', {}, u.name, u.clubs && h('div', { class: 'muted' }, u.clubs)),
          round.dates.map(d => { const [t, k] = ICON[availStatus(by, u, d)]; return h('td', { class: 'av ' + k }, t); }),
          h('td', {}))))))),
    h('div', { class: 'card' }, h('h2', {}, `Haven't replied (${missing.length})`),
      missing.length ? [h('p', {}, missing.map(u => u.name).join(', ')),
        h('button', { class: 'btn', type: 'button', onclick: async () => { toast(await copyText(emails.join(', ')) ? 'Emails copied' : 'Could not copy', 'ok'); } }, 'Copy their emails'), ' ',
        h('a', { class: 'btn', href: `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent('Availability needed: ' + round.title)}&body=${encodeURIComponent('Please check your availability for ' + round.title + ' (' + fmtRange(round.dates) + ') and tap Save.\n\n' + location.origin + location.pathname)}` }, 'Open reminder email')]
        : h('p', { class: 'muted' }, 'Everyone has replied.')));
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
  const sections = groupSections(games.filter(g => !g.removed));
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
    h('div', { class: 'row-between noprint' }, h('h1', {}, round.title), h('span', { class: 'muted' }, fmtRange(round.dates))),
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
    const add = h('textarea', { rows: 5, placeholder: 'One umpire per line:\nName, email, club (optional), mobile (optional)\nJ Smith, j.smith@example.com, Kings Langley' });
    const addBtn = h('button', { class: 'btn primary', type: 'button' }, 'Add umpires');
    addBtn.onclick = busy(addBtn, async () => {
      const lines = add.value.split('\n').map(l => l.trim()).filter(Boolean);
      let added = 0; const bad = [];
      for (const line of lines) {
        const [name, email, clubs = '', phone = ''] = line.split(/[,\t]/).map(s => s.trim());
        const key = emailKey(email);
        if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) { bad.push(line); continue; }
        if (umpires.some(u => u.email === key)) continue;
        const u = { pid: newPid(), email: key, name, clubs, phone, active: true, updatedAt: new Date().toISOString() };
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
        h('thead', {}, h('tr', {}, ['Active', 'Name', 'Email', 'Club(s)', 'Mobile'].map(c => h('th', {}, c)))),
        h('tbody', {}, umpires.map(u => h('tr', { class: u.active ? '' : 'needs' },
          h('td', {}, h('input', { type: 'checkbox', checked: !!u.active, 'aria-label': 'Active', onchange: e => save(u, { active: e.target.checked }) })),
          h('td', {}, field(u, 'name')), h('td', { class: 'muted' }, u.email), h('td', {}, field(u, 'clubs', 'e.g. Kings Langley')), h('td', {}, field(u, 'phone'))))))),
      !umpires.length && h('p', { class: 'muted' }, 'No umpires yet. Add some below, or ask them to sign in and fill in their details.')),
      h('div', { class: 'card' }, h('h2', {}, 'Add umpires'), h('p', { class: 'muted' }, 'Paste your existing list (for example from the Google Form responses). Added umpires are active straight away and can sign in with that email address.'), add, addBtn));
  };
  draw();
  return wrap;
}
