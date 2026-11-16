// The appointments officer never creates rounds by hand. Each competition's NEXT round is built
// automatically from the Play Cricket fixtures, and the season dates umpires answer for are
// rebuilt from the same fetch.

import { CONFIG } from './config.js';
import { makeApi, fetchSeasons, fetchCompetitions, loadFixtures, mergeFixtures } from './fixtures.js';
import { buildCalendar, compKeyOf, summarise, COMPS } from './logic.js';

// Bump when the information saved on each round changes shape, so stored rounds are rebuilt on the next visit.
export const SCHEMA = 5;
export const STALE_MS = 12 * 60 * 60 * 1000;   // refetch the fixtures at most twice a day on its own

export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastDay = g => g.days[g.days.length - 1].date;

// New games start with the grades the officer ticked last time (none the first time).
export function defaultSlotsFn(settings) {
  return g => (settings && settings.slotsByGrade && settings.slotsByGrade[g.grade]) || 0;
}

// A competition's rounds, soonest first. Each is the games whose first day falls in one week, the week starting at the
// earliest game not yet covered. A week, not a round number, because grades in the same competition (Juniors especially)
// number their rounds differently. A two-day round and the one-day games that start on its second Saturday are
// therefore two windows, so each can be given its own umpires.
export function roundWindows(games, today, max = 12) {
  const live = games.filter(g => !g.removed && lastDay(g) >= today);
  const out = [];
  let after = '';
  while (out.length < max) {
    const rest = live.filter(g => g.days[0].date > after);
    if (!rest.length) break;
    const from = rest.map(g => g.days[0].date).sort()[0];
    const to = addDays(from, 6);
    out.push({ from, to, games: rest.filter(g => g.days[0].date <= to) });
    after = to;
  }
  return out;
}

export const nextRoundWindow = (games, today) => roundWindows(games, today, 1)[0] || null;

// 'Round 5' = the round name most of the games share.
export function majorityRound(games) {
  const n = new Map();
  for (const g of games) n.set(g.roundName, (n.get(g.roundName) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))[0][0] || 'Next round';
}

const datesOf = games => [...new Set(games.flatMap(g => g.days.map(d => d.date)))].sort();

export function buildRound({ key, win, games, season, compIds = [], source = null }) {
  const dates = datesOf(games);
  return {
    id: `${key}-${win.from}`, comp: key, title: majorityRound(games),
    start: dates[0], end: dates[dates.length - 1], dates, published: false,
    season: { id: season.id, name: season.name },
    source: source || { type: 'playcricket', seasonId: season.id, comps: compIds, from: win.from, to: win.to },
    ...summarise(games),
  };
}

// Rounds this module builds (id = '<competition>-<first day>') that have not finished; older all-competition rounds are ignored.
export const upcomingRounds = (rounds, today) => rounds
  .filter(r => r.comp && new RegExp(`^${r.comp}-\\d{4}-\\d{2}-\\d{2}$`).test(r.id) && (r.end || '') >= today)
  .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

// A competition's soonest unfinished round.
export const currentRound = (rounds, key, today) => upcomingRounds(rounds, today).find(r => r.comp === key) || null;

// The order tiles are shown in.
export const TILE_ORDER = ['senior', 'junior', 't20'];

// The Sunday that ends the weekend a date falls in (a Saturday takes the Sunday after it).
const weekendEnd = iso => addDays(iso, (7 - new Date(iso + 'T00:00:00Z').getUTCDay()) % 7);

// Rounds grouped into sets: the appointment work for one stretch of play, soonest first.
// A set starts with the earliest round left over. It takes every round that starts in that weekend. If something in
// it runs into later weekends (a two-day round), it also takes the one-day rounds that start in those weekends; a
// further two-day round starts the next set.
export function roundSets(rounds, today) {
  const left = upcomingRounds(rounds, today);
  const order = k => TILE_ORDER.indexOf(k);
  const sets = [];
  while (left.length) {
    const first = left.shift();
    const set = [first];
    const anchorEnd = weekendEnd(first.start);
    let end = weekendEnd(first.end);
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < left.length; i++) {
        const r = left[i];
        if (r.start <= anchorEnd || (r.start <= end && r.start === r.end)) {
          set.push(r); left.splice(i--, 1); changed = true;
          const e = weekendEnd(r.end); if (e > end) end = e;
        }
      }
    }
    sets.push(set.sort((a, b) => a.start.localeCompare(b.start) || order(a.comp) - order(b.comp)));   // by date, then Senior, Junior, T20
  }
  return sets;
}

// Which sets to show. At first enough sets for every competition that plays within the fortnight to appear once;
// each `more` adds the next set.
export function visibleRounds(rounds, today, more = 0) {
  const sets = roundSets(rounds, today);
  if (!sets.length) return { sets: [], hasMore: false };
  const horizon = addDays(sets[0][0].start, 13);
  const needed = new Set(sets.flat().filter(r => r.start <= horizon).map(r => r.comp));
  const seen = new Set();
  let n = 0;
  while (n < sets.length && (n === 0 || [...needed].some(k => !seen.has(k)))) { sets[n].forEach(r => seen.add(r.comp)); n++; }
  n = Math.min(sets.length, n + more);
  return { sets: sets.slice(0, n), hasMore: n < sets.length };
}

export function needsSync(season, rounds, today, now = Date.now()) {
  if (!season || !season.calendar || season.schema !== SCHEMA) return true;
  if (now - Date.parse(season.updatedAt || 0) > STALE_MS) return true;
  return season.calendar.some(c => !currentRound(rounds, c.comp || 'senior', today) && c.dates.some(d => d >= today));
}

// A round's games as members may see them: no allocations, no officer notes.
export function fixtureList(round, games) {
  return {
    roundId: round.id, comp: round.comp, dates: round.dates || [], start: round.start, end: round.end, title: round.title || '',
    games: games.filter(g => !g.removed).map(g => ({
      id: g.id, grade: g.grade, comp: g.comp, home: { name: g.home.name }, away: { name: g.away.name },
      ground: g.ground || '', matchType: g.matchType || '', days: g.days.map(d => ({ date: d.date, day: d.day, time: d.time || '' })),
    })),
  };
}

// Save a freshly fetched set of games into a round, keeping allocations. Returns a summary.
export async function applyFresh(store, round, fresh, settings) {
  const old = await store.listGames(round.id);
  const res = mergeFixtures(old, fresh, defaultSlotsFn(settings));
  if (res.games.length) await store.saveGames(round.id, res.games);
  const byId = new Map(old.map(g => [g.id, g]));
  for (const g of res.games) byId.set(g.id, g);
  const all = [...byId.values()];
  const dates = datesOf(all.filter(g => !g.removed));
  const patch = { id: round.id, dates, start: dates[0] || round.start, end: dates[dates.length - 1] || round.end, ...summarise(all), changedAt: new Date().toISOString() };
  await store.saveRound(patch);
  if (store.saveFixtureList) await store.saveFixtureList(round.id, fixtureList({ ...round, ...patch }, all));
  return { ...res, all };
}

// Each association has its own Play Cricket organisation id (set in Settings).
function playCricketId(store) {
  const id = store.org && store.org.playCricketId;
  if (!id) throw new Error('Add your association\'s Play Cricket link in Settings first');
  return id;
}

// Fetch the whole season, rebuild the umpires' date list, and create / update each competition's next round.
export async function syncFromPlayCricket(store, { today, fetchFn, onProgress } = {}) {
  const pc = playCricketId(store);
  const api = makeApi(CONFIG.apiBase, fetchFn);
  const seasons = await fetchSeasons(api, pc);
  const cur = seasons.find(x => x.current) || seasons[0];
  if (!cur) throw new Error('No season found on Play Cricket');
  const comps = await fetchCompetitions(api, pc, cur.id);
  const games = await loadFixtures({ api, comps, from: '0000-01-01', to: '9999-12-31', onProgress });
  return saveSeasonAndRounds(store, { season: { id: cur.id, name: cur.name }, games, comps, today });
}

// Shared with the demo: turn a season's games into the calendar plus one next round per competition.
export async function saveSeasonAndRounds(store, { season, games, comps = [], today, source = undefined }) {
  await store.saveSeason({ ...season, calendar: buildCalendar(games), schema: SCHEMA, updatedAt: new Date().toISOString() });
  const settings = await store.getSettings();
  const existing = await store.listRounds();
  const made = [];
  for (const { key } of COMPS) {
    const list = games.filter(g => compKeyOf(g) === key);
    const compIds = comps.filter(c => compKeyOf(c.name) === key).map(c => c.id);
    for (const win of roundWindows(list, today)) {
      const id = `${key}-${win.from}`;
      const have = existing.find(r => r.id === id);
      if (have) { await applyFresh(store, have, win.games, settings); made.push(id); continue; }
      const fullGames = win.games.map(g => ({ ...g, slots: defaultSlotsFn(settings)(g), alloc: {} }));
      const round = buildRound({ key, win, games: fullGames, season, compIds, source });
      await store.saveRound(round);
      await store.saveGames(id, fullGames);
      if (store.saveFixtureList) await store.saveFixtureList(id, fixtureList(round, fullGames));
      made.push(id);
    }
  }
  return made;
}

// "Update fixtures" on one round: refetch its competition for the same week and merge.
export async function refreshRound(store, round, settings, { fetchFn } = {}) {
  const src = round.source || {};
  if (src.type !== 'playcricket') return null;
  const api = makeApi(CONFIG.apiBase, fetchFn);
  const comps = (await fetchCompetitions(api, playCricketId(store), src.seasonId)).filter(c => (src.comps || []).includes(c.id));
  const fresh = await loadFixtures({ api, comps, from: src.from, to: src.to });
  return applyFresh(store, round, fresh, settings);
}
