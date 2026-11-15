// Sample data for demo mode. "Load sample data" pulls PDCA's real fixtures from Play Cricket
// (Senior, T20 and Junior) and pairs them with made-up umpires. If Play Cricket can't be
// reached it falls back to made-up fixtures that overlap the same way, so the whole flow
// can always be tried without any setup.

import { newPid, compKeyOf, compareGrades, COMPS } from './logic.js';
import { addDays, saveSeasonAndRounds } from './rounds.js';
import { CONFIG } from './config.js';
import { makeApi, fetchSeasons, fetchCompetitions, loadFixtures } from './fixtures.js';

const SEN = 'PDCA Senior Competition';
const JUN = 'PDCA Junior Competition';
const T20 = 'PDCA T20 Competition';

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Sample dates are always "this coming Saturday and the one after", so the demo never looks stale.
export function demoDates(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  const a = iso(d); d.setDate(d.getDate() + 7);
  return [a, iso(d)];
}

const fx = (n, grade, home, away, ground, days, roundName = 'Round 2', matchType = days.length > 1 ? 'Two Day' : 'T20', comp = SEN) => ({
  id: 'demo-' + n, comp, grade, roundName, matchType, status: 'SCHEDULED',
  days: days.map((date, i) => ({ day: i + 1, date, time: '13:30' })),
  home: { name: home, org: home }, away: { name: away, org: away },
  ground, address: '', lat: null, lng: null, slots: 1, alloc: {},
});

export const demoGames = ([D1, D2]) => { const two = [D1, D2]; return [
  fx(1, 'Senior A Grade', 'GLCC Senior Maroon', 'Baulkham Hills', 'McCredie Park', two),
  fx(2, 'Senior A Grade', 'Hills Barbarians A', 'GLCC Senior Gold', 'George Thornton Reserve', two),
  fx(3, 'Senior A Grade', 'Jaguars Sports Club A', 'Kings Langley', 'Auburn Park', two),
  fx(4, 'Senior A Grade', 'Wenty Leagues Black', 'Wenty Leagues White', 'Monty Bennett', two),
  fx(5, 'Senior A Reserve', 'KSS Team 1 Senior', 'Greystanes CC Senior Men', 'Balmoral Road Sports Hub - Oval 1', two),
  fx(6, 'Senior A Reserve', 'Parramatta CCC', 'Box Hill Bears A Res', 'Arthur Philip Reserve', two),
  fx(7, 'Senior B01', 'Kings Langley', 'Vone Sports Club', 'Pearce Reserve', two),
  fx(8, 'Senior B01', 'Wenty Leagues', 'Parramatta CCC', 'Darling Street', two),
  fx(9, 'Senior B01', 'GLCC Senior Mixed C', 'Winston Hills Men A', 'Guildford West Sportsground', two),
  fx(10, 'Senior B02', 'Western Legends NR', 'Wenty Leagues', 'Harold West Reserve', two),
  fx(11, 'Senior B02', 'Greystanes CC Senior', 'KSS Team 2 Senior', 'Roberta Street Park', two),
  fx(12, 'Senior B02', 'Box Hill Bears', 'Seven Hills Seniors A', 'Stringer Road Reserve - Oval 2', two),
  fx(13, 'Senior B09', 'KSS Team Senior', 'Wenty Waratahs Senior Men', 'Eric Mobbs Reserve - Oval 1', two),
  fx(14, 'Senior Women', 'WPHCCC Perry', 'Kellyville TWL Gold', 'John Purchase Public School', [D2], 'Round 1', 'T20', T20),
  fx(15, 'Senior Women', 'Kellyville TWL Blue', 'Winston Hills TWL', 'Bella Vista Oval', [D2], 'Round 1', 'T20', T20),
  // Junior and T20 play on the same days as Seniors: an umpire can be appointed to both.
  fx(16, 'U12 Gold', 'Kings Langley', 'Wenty Leagues', 'Pearce Reserve', [D1], 'Round 2', 'One Day', JUN),
  fx(17, 'U12 Gold', 'Parramatta', 'GLCC', 'Darling Street', [D1], 'Round 2', 'One Day', JUN),
  fx(18, 'U14 Blue', 'Winston Hills', 'Baulkham Hills', 'Bella Vista Oval', [D1, D2], 'Round 2', 'Two Day', JUN),   // juniors mix two-day and one-day games
  fx(19, 'U10 Red', 'Greystanes', 'Box Hill Bears', 'Roberta Street Park', [D2], 'Round 3', 'One Day', JUN),
  fx(20, 'U10 Red', 'Seven Hills', 'Hills Barbarians', 'Harold West Reserve', [D2], 'Round 3', 'One Day', JUN),
  fx(21, 'T20 Mens', 'Wenty Leagues', 'Kings Langley', 'Monty Bennett', [D2], 'Round 1', 'T20', T20),
  fx(22, 'T20 Mens', 'GLCC', 'Parramatta CCC', 'McCredie Park', [D2], 'Round 1', 'T20', T20),
]; };


const NAMES = Array.from({ length: 10 }, (_, i) => `Demo Umpire ${i + 1}`);

const todayIso = () => { const d = new Date(); return iso(d); };

// Real fixtures for the whole season from Play Cricket, or null when the service can't be reached.
export async function loadLiveSeason({ fetchFn, timeoutMs = 45000 } = {}) {
  const work = (async () => {
    const api = makeApi(CONFIG.apiBase, fetchFn);
    const seasons = await fetchSeasons(api, CONFIG.orgId);
    const cur = seasons.find(x => x.current) || seasons[0];
    if (!cur) return null;
    const comps = await fetchCompetitions(api, CONFIG.orgId, cur.id);
    const games = await loadFixtures({ api, comps, from: '0000-01-01', to: '9999-12-31' });
    return games.length ? { season: { id: cur.id, name: cur.name }, games, comps } : null;
  })();
  const timeout = new Promise(res => setTimeout(() => res(null), timeoutMs));
  try { return await Promise.race([work, timeout]); } catch { return null; }
}

// The "current round" for the demo: every game whose first day is in the week starting at the
// next upcoming game (or, if the season is over, the last week).
// Made-up answers that differ by competition, so the demo shows separate availability:
// umpires 3 and 6 never do juniors, umpire 5 does juniors only, and so on.
export function demoAnswer(i, comp, k) {
  if (comp === 'junior' && (i === 3 || i === 6)) return 'no';
  if (comp === 'senior' && i === 5) return 'no';
  return (i + COMPS.findIndex(c => c.key === comp) * 3 + k * 5) % 4 === 0 ? 'no' : 'yes';
}

export async function seedDemo(store, { live = true, fetchFn } = {}) {
  for (const [i, name] of NAMES.entries()) {
    const email = `umpire${i + 1}@demo.test`;
    const had = await store.getUmpire(email);
    await store.saveUmpire({ pid: had ? had.pid : newPid(), email, name, phone: '', active: true });
  }

  const real = live ? await loadLiveSeason({ fetchFn }) : null;
  let seasonInfo, all, comps = [];
  if (real) {
    seasonInfo = real.season; all = real.games; comps = real.comps;
  } else {
    const [D1, D2] = demoDates();
    seasonInfo = { id: 'demo', name: 'Summer 2026/27' };
    all = demoGames([D1, D2]);
    // The rest of the season: another round every fortnight for each competition.
    for (let k = 1; k < 6; k++) {
      const a = addDays(D1, 14 * k), b = addDays(D2, 14 * k);
      all.push(fx(`s${k}`, 'Senior A Grade', 'A', 'B', 'X', [a, b], `Round ${2 + k}`));
      all.push(fx(`j${k}`, 'U12 Gold', 'A', 'B', 'X', [a], `Round ${2 + k}`, 'One Day', JUN));
      all.push(fx(`t${k}`, 'T20 Mens', 'A', 'B', 'X', [b], `Round ${1 + k}`, 'T20', T20));
    }
  }

  // The committee has asked for the first five Senior grades and all T20 grades; Junior is still
  // to be picked, so that tile starts at 0/0 slots.
  const grades = key => [...new Set(all.filter(g => compKeyOf(g) === key).map(g => g.grade))].sort(compareGrades);
  const slotsByGrade = {};
  grades('senior').slice(0, 5).forEach(gr => { slotsByGrade[gr] = 1; });
  grades('t20').forEach(gr => { slotsByGrade[gr] = 1; });
  await store.saveSettings({ slotsByGrade });

  const made = await saveSeasonAndRounds(store, { season: seasonInfo, games: all, comps, today: todayIso(), source: real ? undefined : { type: 'demo' } });
  const season = await store.getSeason();

  // Umpires 1-8 have answered (separately for each competition); 9 and 10 have not replied.
  for (let i = 1; i <= 8; i++) {
    const email = `umpire${i}@demo.test`;
    const u = await store.getUmpire(email);
    const days = {};
    const idx = {};
    for (const r of season.calendar) {
      r.dates.forEach(d => { idx[r.comp] = (idx[r.comp] || 0) + 1; days[`${r.comp}:${d}`] = demoAnswer(i, r.comp, idx[r.comp]); });
    }
    await store.saveAvailability({ seasonId: season.id, email, name: u.name, days, updatedAt: new Date().toISOString() });
  }
  return { live: !!real, rounds: made.length, games: all.length };
}
