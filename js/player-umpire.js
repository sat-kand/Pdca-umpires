// Player umpires: a member who chooses the games they want to umpire (any round, grade or fixture),
// instead of, or as well as, giving their availability for the officer to allocate.
//
// The member's choices are saved with their availability (`picks`). Members cannot write to the rounds
// themselves (only officers can), so the officer's app puts each choice on the Assign board the next time
// it opens: the game is turned on (so its grade shows as selected for that round) and the member's name
// is filled in, marked as a player umpire. What has been put on the board is remembered in the officer's
// settings (`puApplied`), so a choice is added once, a withdrawn choice is taken off again, and if the
// officer swaps the player umpire for someone else, that change stands.

import { fmtDay, gradeShort, summarise } from './logic.js';

// In PDCA a player umpire may only take Senior games.
export const PLAYER_UMPIRE_COMPS = ['senior'];

export const pickKey = (roundId, gameId, date) => `${roundId}|${gameId}|${date}`;
const splitKey = k => { const [roundId, gameId, date] = k.split('|'); return { roundId, gameId, date }; };

// The board games a member's saved choices stand for, as keys. The Player umpire tick box only shows or
// hides that part of their page; a game is given back by removing it and saving.
export function wantedKeys(avail, today) {
  if (!avail) return [];
  return (avail.picks || []).filter(p => PLAYER_UMPIRE_COMPS.includes(p.comp)).flatMap(p => (p.dates || []).filter(d => d >= today).map(d => pickKey(p.roundId, p.gameId, d)));
}

// Officer side: bring the board in line with every member's choices. Returns what changed.
export async function applyPlayerUmpires(store, { today, enabled = true }) {
  if (!enabled) return { added: [], removed: [], blocked: [] };          // switched off in Settings: leave the boards as they are
  const season = await store.getSeason();
  if (!season) return { added: [], removed: [], blocked: [] };
  const [availList, umpires, settings] = await Promise.all([store.listAvailability(season.id), store.listUmpires(), store.getSettings()]);
  const byEmail = new Map(umpires.map(u => [u.email, u]));
  const applied = { ...((settings && settings.puApplied) || {}) };

  // What to add and take off, grouped by round so each round's games are read once.
  const work = new Map();
  const job = rid => { if (!work.has(rid)) work.set(rid, []); return work.get(rid); };
  const emails = new Set([...availList.map(a => a.email), ...Object.keys(applied)]);
  const nextApplied = {};
  for (const email of emails) {
    const a = availList.find(x => x.email === email);
    const u = byEmail.get(email);
    const want = new Set(u ? wantedKeys(a, today) : []);
    const had = new Set(applied[email] || []);
    for (const k of want) if (!had.has(k)) job(splitKey(k).roundId).push({ op: 'add', key: k, email, u });
    for (const k of had) if (!want.has(k) && splitKey(k).date >= today) job(splitKey(k).roundId).push({ op: 'remove', key: k, email, u });
    nextApplied[email] = [...want];
  }
  if (!work.size) return { added: [], removed: [], blocked: [] };

  const added = [], removed = [], blocked = [];
  for (const [roundId, items] of work) {
    const games = await store.listGames(roundId);
    const touched = new Set();
    for (const it of items) {
      const { gameId, date } = splitKey(it.key);
      const g = games.find(x => x.id === gameId);
      if (!g || g.removed || !g.days.some(d => d.date === date)) continue;          // the fixture has gone
      const pid = it.u ? it.u.pid : null;
      const slots = [...((g.alloc || {})[date] || [])];
      const label = `${gradeShort(g.grade)}: ${g.home.name} v ${g.away.name}`;
      if (it.op === 'remove') {
        const i = slots.findIndex(x => x && x.p === pid && x.pu);
        if (i >= 0) {
          slots[i] = null;
          g.alloc = { ...(g.alloc || {}), [date]: slots };
          removed.push({ name: it.u.name, roundId, label, date });
        }
        // Their place may already be empty (they pulled out with "I can't do this"). Either way the
        // game is no longer a player umpire game, and one that was only on for them goes off the board.
        const anyone = Object.values(g.alloc || {}).some(arr => (arr || []).some(Boolean));
        if (i >= 0 || g.puGame || (g.puOnly && !anyone)) {
          g.puGame = false;
          if (g.puOnly && !anyone) { g.slots = 0; g.puOnly = false; }
          touched.add(g.id);
        }
        continue;
      }
      if (slots.some(x => x && x.p === pid)) continue;                                // already there
      let n = Math.max(g.slots || 0, 1);
      let i = Array.from({ length: n }, (_, j) => j).find(j => !slots[j]);
      if (i === undefined && n < 2) { n = 2; i = 1; }
      if (i === undefined) {
        g.changeNote = `${it.u.name} asked to umpire this on ${fmtDay(date)} as a player umpire, but both places are taken`;
        touched.add(g.id);
        blocked.push({ name: it.u.name, roundId, label, date });
        continue;
      }
      slots[i] = { p: pid, n: it.u.name, pu: true };
      // Turns this one game on. If its grade was not selected, only this game shows (`puOnly`), and the
      // grade itself stays unselected until the officer ticks it in Select grades.
      if (!(g.slots || 0)) g.puOnly = true;
      g.puGame = true;                                                                 // stays on even if its grade is later unticked
      g.slots = n;
      g.alloc = { ...(g.alloc || {}), [date]: slots };
      touched.add(g.id);
      added.push({ name: it.u.name, roundId, label, date });
    }
    if (touched.size) {
      for (const g of games) if (touched.has(g.id)) await store.saveGame(roundId, g);
      await store.saveRound({ id: roundId, ...summarise(games), changedAt: new Date().toISOString() });
    }
  }
  await store.saveSettings({ puApplied: nextApplied });
  return { added, removed, blocked };
}

// Who chose which game, day by day, for the Assign board. `claimOf(pid, date, comp)` gives the game id a player
// umpire chose for that day; `pickOf` gives the whole choice. A choice comes before their date answers: on
// that day they are only put in the game they chose. Nothing is claimed while player umpiring is off.
export function claimsFrom(availList, umpires, enabled = true) {
  const byDay = new Map();
  if (enabled) {
    const pidOf = new Map(umpires.map(u => [u.email, u.pid]));
    for (const a of availList || []) {
      const pid = pidOf.get(a.email);
      if (!pid) continue;
      for (const p of a.picks || []) {
        if (!PLAYER_UMPIRE_COMPS.includes(p.comp)) continue;
        for (const d of p.dates || []) byDay.set(`${pid}|${p.comp}|${d}`, p);
      }
    }
  }
  // Only within the competition they chose in: in any other competition they are a full umpire as usual.
  const pickOf = (pid, date, comp) => byDay.get(`${pid}|${comp}|${date}`) || null;
  return { pickOf, claimOf: (pid, date, comp) => { const p = pickOf(pid, date, comp); return p ? p.gameId : null; } };
}
