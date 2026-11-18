// The appointments officer never creates rounds by hand. Each competition's NEXT round is built
// automatically from the Play Cricket fixtures, and the season dates umpires answer for are
// rebuilt from the same fetch.

import { CONFIG } from './config.js';
import { makeApi, fetchSeasons, fetchCompetitions, loadFixtures, mergeFixtures } from './fixtures.js';
import { buildCalendar, compKeyOf, summarise, COMPS, groupOrder } from './logic.js';

// Bump when the information saved on each round changes shape, so stored rounds are rebuilt on the next visit.
export const SCHEMA = 5;
export const STALE_MS = 12 * 60 * 60 * 1000;   // refetch the fixtures at most twice a day on its own

export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastDay = g => g.days[g.days.length - 1].date;

// New games start with the grades the officer ticked last time (none the first time).
export function defaultSlotsFn(settings) {
  return g => (settings && settings.slotsByGrade && settings.slotsByGrade[g.grade]) || 0;
}

// The first day of the week a date falls in. Weeks run Monday to Sunday unless the association says
// otherwise (startDay: 0 = Sunday ... 6 = Saturday).
export const weekOf = (iso, startDay = 1) => {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return addDays(iso, -((d - startDay + 7) % 7));
};

// A group's rounds, soonest first: one per calendar week, holding the games whose FIRST day is in that
// week (Friday nights, Saturdays and Sundays together). A two-day game belongs to the week it starts in,
// where both its days are allocated; its second day is shown in the next week as "continuing".
// A week, not a round number, because grades number their rounds differently and associations play
// on different days.
export function roundWindows(games, today, max = 12, startDay = 1) {
  const live = games.filter(g => !g.removed && lastDay(g) >= today);
  const weeks = [...new Set(live.map(g => weekOf(g.days[0].date, startDay)))].sort().slice(0, max);
  return weeks.map(from => ({ from, to: addDays(from, 6), games: live.filter(g => weekOf(g.days[0].date, startDay) === from) }));
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

// The order tiles are shown in: the association's group order.
export const tileOrder = groupOrder;

// Rounds grouped by the week they start in, soonest first; within a week, in the association's group
// order. Each set carries its week (`set.week`, its first day).
export function roundSets(rounds, today, startDay = 1) {
  const by = new Map();
  for (const r of upcomingRounds(rounds, today)) {
    const w = weekOf(r.start, startDay);
    if (!by.has(w)) by.set(w, []);
    by.get(w).push(r);
  }
  return [...by.keys()].sort().map(w => Object.assign(
    by.get(w).sort((a, b) => groupOrder(a.comp) - groupOrder(b.comp) || a.start.localeCompare(b.start)), { week: w }));
}

// Which sets to show. At first enough sets for every competition that plays within the fortnight to appear once;
// each `more` adds the next set.
export function visibleRounds(rounds, today, more = 0, startDay = 1) {
  const sets = roundSets(rounds, today, startDay);
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
  const startDay = (store.org && Number.isInteger(store.org.weekStart)) ? store.org.weekStart : 1;
  const ROUND_ID = /^[a-z0-9_-]+-(\d{4}-\d{2}-\d{2})$/;
  for (const { key } of COMPS) {
    const list = games.filter(g => compKeyOf(g) === key);
    const compIds = [...new Set(list.map(g => g.compId).filter(Boolean))].concat(comps.filter(c => compKeyOf(c.name) === key).map(c => c.id));
    for (const win of roundWindows(list, today, 12, startDay)) {
      const id = `${key}-${win.from}`;
      // Keep the round already made for this group and week (rounds made before weeks were used were
      // named after their first game's date), so its allocations carry over.
      const have = existing.find(r => r.id === id)
        || existing.find(r => r.comp === key && !made.includes(r.id) && (r.end || '') >= today
          && ROUND_ID.test(r.id) && weekOf(r.start || r.id.match(ROUND_ID)[1], startDay) === win.from);
      if (have) {
        await applyFresh(store, have, win.games, settings);
        if ((have.source || {}).type === 'playcricket') await store.saveRound({ id: have.id, source: { ...have.source, comps: compIds, from: win.from, to: win.to } });
        made.push(have.id);
        continue;
      }
      const fullGames = win.games.map(g => ({ ...g, slots: defaultSlotsFn(settings)(g), alloc: {} }));
      const round = buildRound({ key, win, games: fullGames, season, compIds, source });
      await store.saveRound(round);
      await store.saveGames(id, fullGames);
      if (store.saveFixtureList) await store.saveFixtureList(id, fixtureList(round, fullGames));
      made.push(id);
    }
  }
  // Upcoming rounds no longer made (their grades moved to another group, or the group was removed):
  // their games are marked as gone, so nothing is shown twice. Allocations stay with the games.
  for (const r of existing) {
    if (made.includes(r.id) || !ROUND_ID.test(r.id) || (r.end || '') < today) continue;
    await applyFresh(store, r, [], settings);
  }
  return made;
}

// "Update fixtures" on one round: refetch its competition for the same week and merge.
export async function refreshRound(store, round, settings, { fetchFn } = {}) {
  const src = round.source || {};
  if (src.type !== 'playcricket') return null;
  const api = makeApi(CONFIG.apiBase, fetchFn);
  const comps = (await fetchCompetitions(api, playCricketId(store), src.seasonId)).filter(c => (src.comps || []).includes(c.id));
  // Only this group's games: a competition can feed more than one group.
  const fresh = (await loadFixtures({ api, comps, from: src.from, to: src.to })).filter(g => compKeyOf(g) === round.comp);
  return applyFresh(store, round, fresh, settings);
}
