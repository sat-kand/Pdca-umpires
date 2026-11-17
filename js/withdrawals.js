// An umpire who answers "Not available" after a round has been published has to be taken off the
// games they were given, and the appointments officer has to hear about it.
//
// The umpire's own app cannot edit rounds (only officers can), so saving their availability records
// a *withdrawal* and queues an email to the address in Settings. The officer's app applies it the
// next time the Allocate page opens: the slots go back to empty and the game carries a note.

import { compLabel, fmtDay, gradeShort, summarise } from './logic.js';
import { todayLocal } from './ui.js';

const dateOf = key => key.slice(key.indexOf(':') + 1);
const compOf = key => key.slice(0, key.indexOf(':'));

// Dates this umpire has just turned to "Not available" (or cleared) after saying they could do them.
export function turnedDown(before = {}, after = {}) {
  return Object.keys({ ...before, ...after })
    .filter(k => before[k] === 'yes' && after[k] !== 'yes')
    .map(k => ({ comp: compOf(k), date: dateOf(k) }));
}

// The published games this umpire is allocated to on those dates.
export async function affectedGames(store, { umpire, dropped, today = todayLocal() }) {
  if (!dropped.length) return [];
  const rounds = (await store.listRounds()).filter(r => r.published && (r.end || '') >= today);
  const out = [];
  for (const r of rounds) {
    const wanted = dropped.filter(d => (r.comp || 'senior') === d.comp && (r.dates || []).includes(d.date));
    if (!wanted.length) continue;
    for (const g of await store.listGames(r.id)) {
      if (g.removed) continue;
      for (const { date } of wanted) {
        const slots = (g.alloc || {})[date] || [];
        if (slots.some(a => a && a.p === umpire.pid)) {
          out.push({ roundId: r.id, gameId: g.id, date, comp: r.comp || 'senior',
            label: `${gradeShort(g.grade)}: ${g.home.name} v ${g.away.name}` });
        }
      }
    }
  }
  return out;
}

// Called when an umpire saves their availability. Returns the withdrawal, or null when nothing published
// is affected (the usual case). Never throws: a failure here must not lose the umpire's own save.
// `also` adds days they turned down that were not a 'yes' before, such as a game they chose as a player umpire.
export async function recordWithdrawal(store, { umpire, before, after, also = [], today = todayLocal() }) {
  try {
    const seen = new Set();
    const dropped = [...turnedDown(before, after), ...also].filter(d => d.date >= today && !seen.has(d.comp + d.date) && seen.add(d.comp + d.date));
    if (!dropped.length) return null;
    const games = await affectedGames(store, { umpire, dropped, today });
    if (!games.length) return null;
    const w = {
      id: `w-${umpire.pid}-${Date.now().toString(36)}`,
      email: umpire.email, name: umpire.name, pid: umpire.pid,
      games, handled: false, createdAt: new Date().toISOString(),
    };
    await store.saveWithdrawal(w);
    await queueEmail(store, w);
    return w;
  } catch (e) {
    console.error('could not record the withdrawal', e);
    return null;
  }
}

async function queueEmail(store, w) {
  const org = store.org || {};
  if (!org.notifyEmail || !store.queueMail) return;
  const lines = w.games.map(g => `  • ${fmtDay(g.date)} — ${compLabel(g.comp)} — ${g.label}`);
  await store.queueMail({
    to: org.notifyEmail,
    orgId: org.id,
    createdAt: new Date().toISOString(),
    message: {
      subject: `${w.name} is no longer available (${w.games.length} allocated game${w.games.length === 1 ? '' : 's'})`,
      text: `${w.name} (${w.email}) has changed their availability to "Not available" for games they were already allocated to:\n\n`
        + `${lines.join('\n')}\n\nThese slots are now unallocated. Open the app to fill them.\n`,
    },
  });
}

// Officer side: free the slots of every withdrawal not yet handled, then return the ones the officer
// has not dismissed, so the banner survives a reload until they have seen it.
//
// An umpire can change their mind (or have tapped by mistake): if, after pulling out, they say
// Available again for that day, or choose that same game again as a player umpire, the pull-out is
// undone. Only the published game they were given is ever restored (a withdrawal only lists those),
// and only while its round is still published. Not yet acted on: the place is simply not freed.
// Already freed: they go back in if the place is still empty, the note goes, and so does the banner.
// Someone who has chosen a different game that day as a player umpire is not put back.
export async function applyWithdrawals(store) {
  const all = await store.listWithdrawals();
  // Older records only kept a count of what was freed: treat each of their games as freed.
  for (const w of all) if (w.handled && (w.freed || 0) > 0 && !(w.games || []).some(g => 'freed' in g)) (w.games || []).forEach(g => { g.freed = true; });
  const open = all.filter(w => !w.handled || (w.games || []).some(g => g.freed && !g.restored));
  if (!open.length) return active(all);
  const season = store.getSeason ? await store.getSeason() : null;
  const avail = season && store.listAvailability ? await store.listAvailability(season.id) : [];
  const availOf = email => avail.find(a => a.email === email);
  // Back for this game: said Available for the day since pulling out, or chose the game again.
  const rounds = store.listRounds ? await store.listRounds() : null;
  const live = id => !rounds || rounds.some(r => r.id === id && r.published);
  const isBack = (w, ref) => {
    const a = availOf(w.email);
    if (!a || !live(ref.roundId)) return false;
    const that = (a.picks || []).filter(p => (p.dates || []).includes(ref.date) && (p.comp || 'senior') === (ref.comp || 'senior'));
    if (that.some(p => p.gameId === ref.gameId)) return 'pu';
    if (that.length) return false;                                   // chose another game that day instead
    return (a.days || {})[`${ref.comp}:${ref.date}`] === 'yes' && (a.updatedAt || '') > (w.createdAt || '') ? 'yes' : false;
  };

  for (const w of open) {
    const byRound = new Map();
    for (const ref of w.games || []) {
      if (!byRound.has(ref.roundId)) byRound.set(ref.roundId, []);
      byRound.get(ref.roundId).push(ref);
    }
    for (const [roundId, refs] of byRound) {
      const games = await store.listGames(roundId);
      let touched = false;
      for (const ref of refs) {
        if (ref.restored) continue;
        const game = games.find(x => x.id === ref.gameId);
        const slots = game && ((game.alloc || {})[ref.date] || []);
        const back = isBack(w, ref);
        if (!w.handled) {
          if (back) { ref.restored = true; continue; }                                     // changed their mind in time: nothing to undo
          if (!slots || !slots.some(a => a && a.p === w.pid)) continue;
          game.alloc[ref.date] = slots.map(a => (a && a.p === w.pid ? null : a));
          game.changeNote = `${w.name} is no longer available on ${fmtDay(ref.date)}`;
          ref.freed = true;
          touched = true;
          continue;
        }
        if (!ref.freed || !back) continue;
        // Freed earlier and now back: put them in an empty place if there is one.
        ref.restored = true;
        if (game) {
          const n = Math.max(game.slots || 0, 1);
          const arr = [...slots];
          const i = Array.from({ length: n }, (_, k) => k).find(k => !arr[k]);
          if (!arr.some(a => a && a.p === w.pid) && i !== undefined) {
            while (arr.length <= i) arr.push(null);
            arr[i] = back === 'pu' ? { p: w.pid, n: w.name, pu: true } : { p: w.pid, n: w.name };
            game.alloc = { ...(game.alloc || {}), [ref.date]: arr };
          }
          if ((game.changeNote || '').startsWith(`${w.name} is no longer available`)) game.changeNote = '';
          touched = true;
        }
      }
      if (touched) {
        for (const g of games) if (refs.some(r => r.gameId === g.id)) await store.saveGame(roundId, g);
        await store.saveRound({ id: roundId, ...summarise(games), changedAt: new Date().toISOString() });
      }
    }
    if (!w.handled) { w.handled = true; w.handledAt = new Date().toISOString(); }
    w.freed = (w.games || []).filter(g => g.freed && !g.restored).length;
    await store.saveWithdrawal(w);
  }
  return active(all);
}

// What the banner lists: games still pulled out of, for withdrawals the officer has not dismissed.
const active = all => all
  .filter(w => !w.dismissed && (w.games || []).some(g => g.freed && !g.restored))
  .map(w => ({ ...w, shown: w.games.filter(g => g.freed && !g.restored) }))
  .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

// The officer has read the banner.
export async function dismissWithdrawals(store, list) {
  for (const { shown, ...w } of list) await store.saveWithdrawal({ ...w, dismissed: true });
}
