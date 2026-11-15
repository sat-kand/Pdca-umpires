// Sample data for demo mode: fixtures modelled on a two-day Seniors round and
// made-up umpires, so the whole flow can be tried without any setup.

import { newPid, recount, fmtRange } from './logic.js';

const SEN = 'PDCA Senior Competition';

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Sample dates are always "this coming Saturday and the one after", so the demo never looks stale.
export function demoDates(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  const a = iso(d); d.setDate(d.getDate() + 7);
  return [a, iso(d)];
}

const fx = (n, grade, home, away, ground, days, roundName = 'Round 2', matchType = days.length > 1 ? 'Two Day' : 'T20') => ({
  id: 'demo-' + n, comp: SEN, grade, roundName, matchType, status: 'SCHEDULED',
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
  fx(14, 'Senior Women', 'WPHCCC Perry', 'Kellyville TWL Gold', 'John Purchase Public School', [D2], 'Round 4', 'T20'),
  fx(15, 'Senior Women', 'Kellyville TWL Blue', 'Winston Hills TWL', 'Bella Vista Oval', [D2], 'Round 4', 'T20'),
]; };

const NAMES = [
  ['Demo Umpire 1', 'Kings Langley'], ['Demo Umpire 2', 'Wenty Leagues'], ['Demo Umpire 3', ''],
  ['Demo Umpire 4', ''], ['Demo Umpire 5', 'Winston Hills'], ['Demo Umpire 6', ''],
  ['Demo Umpire 7', 'Parramatta'], ['Demo Umpire 8', ''], ['Demo Umpire 9', ''], ['Demo Umpire 10', 'GLCC'],
];

export async function seedDemo(store) {
  for (const [i, [name, clubs]] of NAMES.entries()) {
    const email = `umpire${i + 1}@demo.test`;
    const had = await store.getUmpire(email);
    await store.saveUmpire({ pid: had ? had.pid : newPid(), email, name, phone: '', clubs, active: true });
  }
  const [D1, D2] = demoDates();
  const games = demoGames([D1, D2]);
  const round = {
    id: 'r-' + D1, title: `Round 2 Seniors – ${fmtRange([D1, D2])}`, start: D1, end: D2,
    dates: [D1, D2], availabilityOpen: true, published: false,
    season: { id: 'demo', name: 'Summer 2026/27' },
    source: { type: 'demo' }, stats: recount(games),
  };
  await store.saveRound(round);
  await store.saveGames(round.id, games);
  // a mix of responses; umpires 9 and 10 have not replied
  const pat = [
    ['yes', 'yes'], ['yes', 'maybe'], ['yes', 'yes'], ['no', 'yes'], ['yes', 'no'],
    ['maybe', 'yes'], ['yes', 'yes'], ['yes', 'yes'],
  ];
  for (const [i, [a, b]] of pat.entries()) {
    const email = `umpire${i + 1}@demo.test`;
    const u = await store.getUmpire(email);
    await store.saveAvailability({ roundId: round.id, email, name: u.name, days: { [D1]: a, [D2]: b }, note: '', updatedAt: new Date().toISOString() });
  }
}
