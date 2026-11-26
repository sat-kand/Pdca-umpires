// Sample data for demo mode: made-up umpires and made-up fixtures that overlap the way real ones do,
// so the whole flow can be tried without any setup or network.

import { newPid, compKeyOf, compareGrades, COMPS } from './logic.js';
import { addDays, saveSeasonAndRounds, buildRound, ensureGroups } from './rounds.js';

// Competitions for the made-up fixtures.
const SEN = 'Senior Competition';
const JUN = 'Junior Competition';
const T20 = 'T20 Competition';

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
  fx(19, 'U12 Blue', 'Greystanes', 'Box Hill Bears', 'Roberta Street Park', [D2], 'Round 3', 'One Day', JUN),
  fx(20, 'U12 Blue', 'Seven Hills', 'Hills Barbarians', 'Harold West Reserve', [D2], 'Round 3', 'One Day', JUN),
  fx(21, 'T20 Mens', 'Wenty Leagues', 'Kings Langley', 'Monty Bennett', [D2], 'Round 1', 'T20', T20),
  fx(22, 'T20 Mens', 'GLCC', 'Parramatta CCC', 'McCredie Park', [D2], 'Round 1', 'T20', T20),
]; };


// Sample umpires, named as they appear on an allocation sheet (initial and surname).
// Emails stay umpire1@demo.test ... umpire10@demo.test, so anyone can sign in as one in the demo.
const NAMES = [
  ['G', 'Serrao'], ['D', 'Everton'], ['K', 'Bakon'], ['B', 'Chellapa'], ['R', 'Dryburgh'],
  ['W', 'Jayashri'], ['D', 'Henry'], ['M', 'Krish'], ['H', 'Murali'], ['V', 'Palaniappan'],
];

const todayIso = () => { const d = new Date(); return iso(d); };

// The "current round" for the demo: every game whose first day is in the week starting at the
// next upcoming game (or, if the season is over, the last week).
// Made-up answers that differ by group, so the demo shows separate availability: umpires 3 and 6
// never do the last group, umpire 5 never does the first, and so on.
export function demoAnswer(i, comp, k) {
  const g = COMPS.findIndex(c => c.key === comp);
  if (g > 0 && g === COMPS.length - 1 && (i === 3 || i === 6)) return 'no';
  if (g === 0 && i === 5) return 'no';
  return (i + g * 3 + k * 5) % 4 === 0 ? 'no' : 'yes';
}

// Applicants waiting for approval (not counted among the sample umpires above).
const APPLICANTS = [['Priya', 'Nair', 'applicant1@demo.test'], ['Tom', 'Walsh', 'applicant2@demo.test'], ['Lena', 'Okafor', 'applicant3@demo.test']];

export async function seedDemo(store) {
  for (const [i, [firstName, lastName]] of NAMES.entries()) {
    const email = `umpire${i + 1}@demo.test`;
    const had = await store.getUmpire(email);
    await store.saveUmpire({ pid: had ? had.pid : newPid(), email, name: `${firstName} ${lastName}`, firstName, lastName, phone: '', dob: '', address: '', accreditation: `L${(i % 3) + 1}-${2200 + i}`, active: true });
  }
  // Three people who applied through the join link and are waiting to be approved; the first has
  // already given availability, so they show as Available Non-Member on the board.
  for (const [firstName, lastName, email] of APPLICANTS) {
    const had = await store.getUmpire(email);
    if (!had) await store.saveUmpire({ pid: newPid(), email, name: `${firstName} ${lastName}`, firstName, lastName, active: false, updatedAt: new Date().toISOString() });
  }
  // A few of them are (or were) members of other associations too, so the profile page has something to show.
  if (store.seedOtherMemberships) await store.seedOtherMemberships({
    'umpire1@demo.test': [{ orgId: 'hdca', orgName: 'Hills District Cricket Association', membership: 'Ordinary member', active: true, since: '2019-09-01' }],
    'umpire2@demo.test': [{ orgId: 'nsca', orgName: 'Nepean Cricket Association', membership: 'Ordinary member', active: false, since: '2014-10-01' },
      { orgId: 'hdca', orgName: 'Hills District Cricket Association', membership: 'Life member', active: true, since: '2022-08-20' }],
  });

  const [D1, D2] = demoDates();
  const seasonInfo = { id: 'demo', name: 'Summer 2026/27' };
  const all = demoGames([D1, D2]);
  // The rest of the season: another round every fortnight for each competition.
  for (let k = 1; k < 6; k++) {
    const a = addDays(D1, 14 * k), b = addDays(D2, 14 * k);
    all.push(fx(`s${k}`, 'Senior A Grade', 'A', 'B', 'X', [a, b], `Round ${2 + k}`));
    all.push(fx(`j${k}`, 'U12 Gold', 'A', 'B', 'X', [a], `Round ${2 + k}`, 'One Day', JUN));
    all.push(fx(`t${k}`, 'T20 Mens', 'A', 'B', 'X', [b], `Round ${1 + k}`, 'T20', T20));
  }

  // The made-up competitions, as a fixture service would list them (so the groups are suggested the same way).
  const comps = [...new Set(all.map(g => g.comp))].map(name => ({ id: name, name, grades: [...new Set(all.filter(g => g.comp === name).map(g => g.grade))].map(gr => ({ id: gr, name: gr })) }));
  // The association's groups, suggested from its own competitions.
  await ensureGroups(store, all, comps);
  // The committee has asked for the first five grades of the first group and every grade of the groups
  // in between; the last group is still to be picked, so its tiles start at "Choose grades".
  const grades = key => [...new Set(all.filter(g => compKeyOf(g) === key).map(g => g.grade))].sort(compareGrades);
  const keys = COMPS.map(c => c.key);
  const slotsByGrade = {};
  grades(keys[0]).slice(0, 5).forEach(gr => { slotsByGrade[gr] = 1; });
  keys.slice(1, -1).forEach(k => grades(k).forEach(gr => { slotsByGrade[gr] = 1; }));
  await store.saveSettings({ slotsByGrade });
  const made = await saveSeasonAndRounds(store, { season: seasonInfo, games: all, comps, today: todayIso(), source: { type: 'demo' } });
  const season = await store.getSeason();

  // Made-up finished rounds on the two Saturdays just gone, so "Past allocations" has something to show.
  const [N1] = demoDates();
  const P1 = addDays(N1, -14), P2 = addDays(N1, -7);
  const ump = [];
  for (let i = 1; i <= 8; i++) { const u = await store.getUmpire(`umpire${i}@demo.test`); ump.push({ p: u.pid, n: u.name }); }
  // Grade names come from the sample fixtures above.
  const realGrades = key => grades(key).length ? grades(key) : null;
  const gr = (key, i, fallback) => { const l = realGrades(key); return l ? l[i % l.length] : fallback; };
  const K1 = keys[0], K2 = keys[keys.length - 1];
  const past = [
    { key: K1, published: true, games: [
      fx('p1', gr(K1, 0, 'Senior A Grade'), 'GLCC Senior Maroon', 'Kings Langley', 'McCredie Park', [P1, P2], 'Round 1'),
      fx('p2', gr(K1, 0, 'Senior A Grade'), 'Wenty Leagues Black', 'Baulkham Hills', 'Monty Bennett', [P1, P2], 'Round 1'),
      fx('p3', gr(K1, 1, 'Senior A Reserve'), 'Parramatta CCC', 'KSS Team 1 Senior', 'Arthur Philip Reserve', [P1, P2], 'Round 1'),
      fx('p4', gr(K1, 2, 'Senior B01'), 'Wenty Leagues', 'Vone Sports Club', 'Darling Street', [P1, P2], 'Round 1')] },
    { key: K2, published: true, games: [
      fx('p5', gr(K2, 0, 'U14 Blue'), 'Winston Hills', 'Baulkham Hills', 'Bella Vista Oval', [P1], 'Round 1', 'One Day', JUN),
      fx('p6', gr(K2, 1, 'U12 Gold'), 'Parramatta', 'GLCC', 'Darling Street', [P1], 'Round 1', 'One Day', JUN)] },
    { key: K2, published: false, games: [
      fx('p7', gr(K2, 0, 'U14 Blue'), 'Baulkham Hills', 'Kings Langley', 'Pearce Reserve', [P2], 'Round 2', 'One Day', JUN),
      fx('p8', gr(K2, 1, 'U12 Gold'), 'GLCC', 'Wenty Leagues', 'Roberta Street Park', [P2], 'Round 2', 'One Day', JUN)] },
  ];
  let n = 0;
  for (const r of past) {
    r.games.forEach((g, gi) => { for (const d of g.days) if (r.published || gi === 0) g.alloc[d.date] = [ump[(n + gi) % ump.length]]; });
    n += r.games.length;
    const from = r.games[0].days[0].date;
    const round = buildRound({ key: r.key, win: { from, to: addDays(from, 6) }, games: r.games, season: seasonInfo, source: { type: 'demo' } });
    await store.saveRound({ ...round, published: r.published });
    await store.saveGames(round.id, r.games);
  }

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
  {
    const [firstName, lastName, email] = APPLICANTS[0];
    const days = {};
    for (const r of season.calendar) r.dates.forEach((d, k) => { days[`${r.comp}:${d}`] = k % 3 === 2 ? 'no' : 'yes'; });
    await store.saveAvailability({ seasonId: season.id, email, name: `${firstName} ${lastName}`, days, updatedAt: new Date().toISOString() });
  }
  return { rounds: made.length, games: all.length };
}
