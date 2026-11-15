// The appointments officer never creates rounds by hand. Each competition's NEXT round is built
// automatically from the Play Cricket fixtures, and the season dates umpires answer for are
// rebuilt from the same fetch.

import { CONFIG } from './config.js';
import { makeApi, fetchSeasons, fetchCompetitions, loadFixtures, mergeFixtures } from './fixtures.js';
import { buildCalendar, compKeyOf, summarise, COMPS } from './logic.js';

// Bump when the information saved on each round changes shape, so stored rounds are rebuilt on the next visit.
export const SCHEMA = 3;
export const STALE_MS = 12 * 60 * 60 * 1000;   // refetch the fixtures at most twice a day on its own

export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastDay = g => g.days[g.days.length - 1].date;

// New games start with the grades the officer ticked last time (none the first time).
export function defaultSlotsFn(settings) {
  return g => (settings && settings.slotsByGrade && settings.slotsByGrade[g.grade]) || 0;
}

// The next round of one competition: every game whose first day falls in the week that starts at
// the earliest game that has not finished yet. A week, not a round number, because grades in the
// same competition (Juniors especially) number their rounds differently.
export function nextRoundWindow(games, today) {
  const live = games.filter(g => !g.removed && lastDay(g) >= today);
  if (!live.length) return null;
  const from = live.map(g => g.days[0].date).sort()[0];
  const to = addDays(from, 6);
  return { from, to, games: live.filter(g => g.days[0].date >= from && g.days[0].date <= to) };
}

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

// The round to show for a competition: the earliest one that has not finished.
export function currentRound(rounds, key, today) {
  // Only rounds this module builds (id = '<competition>-<first day>'); older all-competition rounds are ignored.
  return rounds.filter(r => r.comp === key && new RegExp(`^${key}-\\d{4}-\\d{2}-\\d{2}$`).test(r.id) && (r.end || '') >= today).sort((a, b) => a.start.localeCompare(b.start))[0] || null;
}

export function needsSync(season, rounds, today, now = Date.now()) {
  if (!season || !season.calendar || season.schema !== SCHEMA) return true;
  if (now - Date.parse(season.updatedAt || 0) > STALE_MS) return true;
  return season.calendar.some(c => !currentRound(rounds, c.comp || 'senior', today) && c.dates.some(d => d >= today));
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
  await store.saveRound({ id: round.id, dates, start: dates[0] || round.start, end: dates[dates.length - 1] || round.end, ...summarise(all) });
  return { ...res, all };
}

// Fetch the whole season, rebuild the umpires' date list, and create / update each competition's next round.
export async function syncFromPlayCricket(store, { today, fetchFn, onProgress } = {}) {
  const api = makeApi(CONFIG.apiBase, fetchFn);
  const seasons = await fetchSeasons(api, CONFIG.orgId);
  const cur = seasons.find(x => x.current) || seasons[0];
  if (!cur) throw new Error('No season found on Play Cricket');
  const comps = await fetchCompetitions(api, CONFIG.orgId, cur.id);
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
    const win = list.length ? nextRoundWindow(list, today) : null;
    if (!win) continue;
    const compIds = comps.filter(c => compKeyOf(c.name) === key).map(c => c.id);
    const id = `${key}-${win.from}`;
    const have = existing.find(r => r.id === id);
    if (have) { await applyFresh(store, have, win.games, settings); made.push(id); continue; }
    const fullGames = win.games.map(g => ({ ...g, slots: defaultSlotsFn(settings)(g), alloc: {} }));
    await store.saveRound(buildRound({ key, win, games: fullGames, season, compIds, source }));
    await store.saveGames(id, fullGames);
    made.push(id);
  }
  return made;
}

// "Update fixtures" on one round: refetch its competition for the same week and merge.
export async function refreshRound(store, round, settings, { fetchFn } = {}) {
  const src = round.source || {};
  if (src.type !== 'playcricket') return null;
  const api = makeApi(CONFIG.apiBase, fetchFn);
  const comps = (await fetchCompetitions(api, CONFIG.orgId, src.seasonId)).filter(c => (src.comps || []).includes(c.id));
  const fresh = await loadFixtures({ api, comps, from: src.from, to: src.to });
  return applyFresh(store, round, fresh, settings);
}
