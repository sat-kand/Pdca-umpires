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
export async function recordWithdrawal(store, { umpire, before, after, today = todayLocal() }) {
  try {
    const dropped = turnedDown(before, after).filter(d => d.date >= today);
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
export async function applyWithdrawals(store) {
  const all = await store.listWithdrawals();
  for (const w of all.filter(x => !x.handled)) {
    const byRound = new Map();
    for (const g of w.games || []) {
      if (!byRound.has(g.roundId)) byRound.set(g.roundId, []);
      byRound.get(g.roundId).push(g);
    }
    let freed = 0;
    for (const [roundId, refs] of byRound) {
      const games = await store.listGames(roundId);
      let touched = false;
      for (const ref of refs) {
        const game = games.find(x => x.id === ref.gameId);
        const slots = game && (game.alloc || {})[ref.date];
        if (!slots || !slots.some(a => a && a.p === w.pid)) continue;
        game.alloc[ref.date] = slots.map(a => (a && a.p === w.pid ? null : a));
        game.changeNote = `${w.name} is no longer available on ${fmtDay(ref.date)}`;
        await store.saveGame(roundId, game);
        freed++;
        touched = true;
      }
      if (touched) await store.saveRound({ id: roundId, ...summarise(games) });
    }
    w.handled = true; w.handledAt = new Date().toISOString(); w.freed = freed;
    await store.saveWithdrawal(w);
  }
  return all.filter(w => !w.dismissed && (w.freed || 0) > 0)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// The officer has read the banner.
export async function dismissWithdrawals(store, list) {
  for (const w of list) await store.saveWithdrawal({ ...w, dismissed: true });
}
