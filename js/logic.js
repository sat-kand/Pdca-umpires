// Pure allocation logic: no DOM, no network, no Firebase. Fully unit-tested.
//
// Data shapes
//   umpire : { pid, email, name, phone, active }
//   game   : { id, comp, grade, roundName, matchType, days:[{day,date,time}],
//              home:{name,org}, away:{name,org}, ground, slots, alloc, ... }
//   alloc  : { '2026-10-10': [ {p:pid, n:name} | null, ... ] }   (one entry per slot)
//   avail  : { [email]: { days: { 'senior:2026-10-10': 'yes'|'no' } } }
//            Availability is given separately per competition (senior / t20 / junior),
//            so a key is `${competition}:${date}`.

export const AVAIL = { YES: 'yes', MAYBE: 'maybe', NO: 'no' };

// ---------- competitions ---------------------------------------------------

// PDCA runs three competitions. Umpires give availability for each one separately,
// and may be appointed to more than one on the same day.
export const COMPS = [
  { key: 'senior', label: 'Senior' },
  { key: 't20', label: 'T20' },
  { key: 'junior', label: 'Junior' },
];

// 'PDCA Junior Competition' -> 'junior', anything with T20/Twenty20 -> 't20', else 'senior'.
export function compKeyOf(x) {
  const name = (typeof x === 'string' ? x : (x && x.comp)) || '';
  if (/junior|\bu\s?\d{1,2}\b|under\s?\d/i.test(name)) return 'junior';
  if (/t\s?20|twenty\s?20/i.test(name)) return 't20';
  return 'senior';
}

export function compLabel(key) { return (COMPS.find(c => c.key === key) || { label: key }).label; }
export function availKey(comp, date) { return `${comp}:${date}`; }

// The (competition, date) pairs a set of games needs availability for.
export function roundColumns(games) {
  const seen = new Map();
  for (const g of games) {
    if (g.removed) continue;
    const comp = compKeyOf(g);
    for (const d of g.days) seen.set(availKey(comp, d.date), { comp, date: d.date, key: availKey(comp, d.date) });
  }
  const order = k => COMPS.findIndex(c => c.key === k);
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date) || order(a.comp) - order(b.comp));
}

// ---------- dates ---------------------------------------------------------

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

export function fmtDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ['2026-10-10','2026-10-17'] -> '10/17 OCT'
export function fmtRange(dates) {
  const ds = [...new Set(dates)].sort();
  if (!ds.length) return '';
  const parts = ds.map(d => ({ day: Number(d.slice(8, 10)), mon: Number(d.slice(5, 7)) - 1 }));
  const sameMonth = parts.every(p => p.mon === parts[0].mon);
  if (sameMonth) return parts.map(p => p.day).join('/') + ' ' + MONTHS[parts[0].mon];
  return parts.map(p => p.day + ' ' + MONTHS[p.mon]).join(' / ');
}

// ---------- grades --------------------------------------------------------

// 'Senior A Grade' -> 'A', 'Senior A Reserve' -> 'Ar', 'Senior B02' -> 'B2'
export function gradeShort(grade) {
  const g = (grade || '').trim();
  let m;
  if ((m = /^Senior\s+B0*(\d+)$/i.exec(g))) return 'B' + m[1];
  if (/^Senior\s+A\s+Grade$/i.test(g)) return 'A';
  if (/^Senior\s+A\s+Reserve$/i.test(g)) return 'Ar';
  if (/^Senior\s+Women/i.test(g)) return 'Women';
  return g.replace(/^Senior\s+/i, '');
}

// Sort key so A, Ar, B1..B16, then everything else, natural order.
export function gradeRank(grade) {
  const s = gradeShort(grade);
  const u = /^U\s?(\d{1,2})\b/i.exec(s);
  if (u) return [0, 100 - Number(u[1]), s];            // Juniors: oldest age group first (U17 ... U10)
  if (s === 'A') return [0, 0, s];
  if (s === 'Ar') return [0, 1, s];
  const m = /^B(\d+)$/.exec(s);
  if (m) return [1, Number(m[1]), s];
  return [2, 0, s];
}

export function compareGrades(a, b) {
  const ra = gradeRank(a), rb = gradeRank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2], undefined, { numeric: true });
}

// The match types Play Cricket gives the games ("One Day", "Two Day", "T20"), joined with " & ".
export function formatSummary(games) {
  const order = t => { const i = ['One Day', 'Two Day', 'T20'].indexOf(t); return i < 0 ? 9 : i; };
  return [...new Set(games.map(g => g.matchType).filter(Boolean))].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).join(' & ');
}

// Where a round stands with umpires: never published, published and current, or changed since.
export function publishState(round = {}) {
  if (!round.published) return { key: round.publishedAt ? 'off' : 'never', cls: '', label: round.publishedAt ? 'Unpublished' : 'Not published yet', short: round.publishedAt ? 'Unpublished' : 'Not published' };
  const stale = round.changedAt && round.publishedAt && round.changedAt > round.publishedAt;
  if (stale) return { key: 'stale', cls: 'warn', label: 'Changed since it was published', short: 'Changes to publish' };
  return { key: 'live', cls: 'ok', label: round.publishedAt ? `Published ${fmtWhen(round.publishedAt)}` : 'Published', short: 'Published' };
}

// '2026-11-16T02:14:00Z' -> '1:14pm, 16 Nov'
export function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const t = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
  return `${t}, ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
}

// ---------- sections (how the report groups games) ------------------------

export function sectionKey(g) {
  return [g.comp, g.roundName, g.matchType].join('|');
}

export function sectionLabel(games) {
  const first = games[0];
  const grades = [...new Set(games.map(g => g.grade))];
  const names = grades.length === 1 ? gradeShort(grades[0]) : /senior/i.test(first.comp) ? 'Seniors' : first.comp.replace(/^PDCA\s+/i, '');
  return `${first.roundName} ${names}`.trim();
}

export function groupSections(games) {
  const map = new Map();
  for (const g of games) {
    const k = sectionKey(g);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(g);
  }
  const out = [...map.entries()].map(([key, list]) => {
    list.sort(compareGames);
    const dates = list.flatMap(g => g.days.map(d => d.date));
    return { key, label: sectionLabel(list), dates: [...new Set(dates)].sort(), games: list };
  });
  out.sort((a, b) => (a.dates[0] || '').localeCompare(b.dates[0] || '') || b.games.length - a.games.length);
  return out;
}

export function compareGames(a, b) {
  return (a.days[0]?.date || '').localeCompare(b.days[0]?.date || '')
    || compareGrades(a.grade, b.grade)
    || (a.home?.name || '').localeCompare(b.home?.name || '');
}

// ---------- allocation state ----------------------------------------------

// A game is "picked" when the officer has chosen its grade for umpires (slots > 0).
export const isPicked = game => (game.slots || 0) > 0;

export function slotCount(game) { return game.removed ? 0 : (game.slots || 0); }

// What umpires see is what was last published, not the officer's work since. Publishing stores a copy
// of the allocation on the round; rounds published before that existed fall back to the live board.
export function publishedSnapshot(games) {
  const out = {};
  for (const g of games) {
    if (g.removed || !isPicked(g)) continue;
    const a = {};
    for (const d of g.days) {
      const arr = allocFor(g, d.date).map(x => (x ? { p: x.p, n: x.n, ...(x.pu ? { pu: true } : {}) } : null));
      if (arr.some(Boolean)) a[d.date] = arr;
    }
    if (Object.keys(a).length) out[g.id] = a;
  }
  return out;
}
export function publishedAllocFor(round, game, date) {
  if (round && round.publishedAlloc) return ((round.publishedAlloc[game.id] || {})[date]) || [];
  return allocFor(game, date);
}

export function allocFor(game, date) {
  const n = slotCount(game);
  const cur = (game.alloc && game.alloc[date]) || [];
  return Array.from({ length: n }, (_, i) => cur[i] || null);
}

// Who is already umpiring in each competition on each date: { 'senior:date': { pid: [gameId, ...] } }
// Games in different competitions never clash: an umpire may do a Senior and a Junior game on one day.
export function buildBusyMap(games) {
  const busy = {};
  for (const g of games) {
    if (g.removed) continue;
    const comp = compKeyOf(g);
    for (const d of g.days) {
      for (const a of allocFor(g, d.date)) {
        if (!a) continue;
        ((busy[availKey(comp, d.date)] ||= {})[a.p] ||= []).push(g.id);
      }
    }
  }
  return busy;
}

export function availStatus(availByEmail, umpire, comp, date) {
  const rec = availByEmail && availByEmail[umpire.email];
  if (!rec || !rec.days) return 'none';
  return rec.days[availKey(comp, date)] || 'none';
}

// Warnings for one umpire in one slot. Empty array = clean.
// `claimOf(pid, date, comp)` gives the game a player umpire chose for that day in that competition (or
// nothing). Their choice comes first: that day they are not given any other game of that competition.
export function assignmentWarnings({ game, date, slotIndex, umpire, availByEmail, busy, chosen = false, claimOf }) {
  const w = [];
  if (umpire.active === false) w.push('Not an active member');
  const comp = compKeyOf(game);
  const claim = claimOf ? claimOf(umpire.pid, date, comp) : null;
  if (claim === game.id) chosen = true;
  else if (claim) w.push('Chose another game as a player umpire this day');
  // A player umpire picked this game themselves: their date answers are for the officer's own allocations.
  const st = chosen ? 'yes' : availStatus(availByEmail, umpire, comp, date);
  if (st === 'no') w.push(`Marked unavailable for ${compLabel(comp)} on this day`);
  else if (st === 'none') w.push(`No ${compLabel(comp)} availability submitted`);
  const others = ((busy[availKey(comp, date)] || {})[umpire.pid] || []).filter(id => id !== game.id);
  if (others.length) w.push(`Already umpiring another ${compLabel(comp)} game this day`);
  const here = allocFor(game, date).filter((a, i) => a && a.p === umpire.pid && i !== slotIndex);
  if (here.length) w.push('Already in this game');
  return w;
}

// Options for a slot dropdown, grouped and sorted.
export function slotOptions({ game, date, slotIndex, umpires, availByEmail, busy, loads, claimOf }) {
  const rows = [];
  const claimed = (pid, dt) => (claimOf ? claimOf(pid, dt, compKeyOf(game)) : null);
  for (const u of umpires) {
    const st = availStatus(availByEmail, u, compKeyOf(game), date);
    const others = ((busy[availKey(compKeyOf(game), date)] || {})[u.pid] || []).filter(id => id !== game.id);
    const dup = allocFor(game, date).some((a, i) => a && a.p === u.pid && i !== slotIndex);
    // A player umpire's own choice comes first: this game is theirs, any other game that day is not.
    const claim = claimed(u.pid, date);
    const chosen = claim === game.id;
    const elsewhere = !!claim && !chosen;
    const avoid = (!chosen && st === 'no') || others.length > 0 || dup || elsewhere;
    // For a multi-day game, who can do EVERY day (free, said yes, not already busy that day)?
    const days = game.days.map(d => d.date);
    const freeOn = dt => availStatus(availByEmail, u, compKeyOf(game), dt) === 'yes' && !claimed(u.pid, dt)
      && !((busy[availKey(compKeyOf(game), dt)] || {})[u.pid] || []).filter(id => id !== game.id).length;
    const okDays = days.filter(freeOn);
    const bothDays = days.length > 1 && okDays.length === days.length;
    // Someone whose membership is not active can still be allocated, but they are kept in a group of
    // their own so the officer chooses them on purpose.
    const member = u.active !== false;
    const group = avoid ? 'avoid'
      : chosen ? 'chosen'
      : !member ? (st === 'yes' ? 'nonmember' : 'avoid')
      : st === 'yes' ? (days.length > 1 ? (bothDays ? 'both' : 'ok') : 'ok') : 'none';
    rows.push({ umpire: u, status: st, busy: others.length > 0, dup, chosen, elsewhere, group, bothDays, okDays, member, load: (loads && loads[u.pid]) || 0 });
  }
  // By last name; in the "unavailable or already allocated" group: those already on a game that day,
  // then player umpires who chose another game, then those who said they are not available.
  const taken = r => (r.busy || r.dup ? 0 : r.elsewhere ? 1 : 2);
  rows.sort((a, b) => (a.group === 'avoid' && b.group === 'avoid' ? taken(a) - taken(b) : 0) || compareMembers(a.umpire, b.umpire));
  return rows;
}

export function recount(games) {
  let needed = 0, filled = 0, gamesNeeding = 0;
  const byUmpire = {};
  for (const g of games) {
    const n = slotCount(g);
    if (!n) continue;
    gamesNeeding++;
    for (const d of g.days) {
      const a = allocFor(g, d.date);
      needed += n;
      for (const s of a) if (s) { filled++; byUmpire[s.p] = (byUmpire[s.p] || 0) + 1; }
    }
  }
  return { games: gamesNeeding, needed, filled, byUmpire };
}

// What a round tile shows: slots filled / needed, and how many grades were picked.
export function summarise(games) {
  const live = games.filter(g => !g.removed);
  const picked = live.filter(isPicked);
  // The round is named after the grades being umpired (all grades until some are picked). A grade playing a
  // different round number (Women, say) is listed under `other` instead of leaving the title inconsistent.
  const basis = picked.length ? picked : live;
  const counts = new Map();
  for (const g of basis) counts.set(g.roundName || '', (counts.get(g.roundName || '') || 0) + 1);
  const title = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))[0];
  const other = [...new Set(basis.filter(g => g.roundName && title && g.roundName !== title[0]).map(g => `${gradeShort(g.grade)}: ${g.roundName}`))].join(' · ');
  return { stats: recount(games), picked: new Set(picked.map(g => g.grade)).size, formats: formatSummary(basis), ...(title && title[0] ? { title: title[0] } : {}), other };
}

// Sum of appointments per umpire across stats from other rounds + this one.
export function seasonLoads(statsList) {
  const out = {};
  for (const s of statsList) for (const [p, n] of Object.entries((s && s.byUmpire) || {})) out[p] = (out[p] || 0) + n;
  return out;
}

// Greedy fill of EMPTY slots using only umpires who said "yes".
// Returns a list of changes; does not mutate. Fairness: least-loaded first.
// How far an umpire can be relied on: the share of their published appointments they kept, from 0 to 1.
// `kept` is games they have this season, `dropped` how many published ones they pulled out of (and did not
// take back). Someone with no record counts as fully reliable.
export function reliabilityOf({ kept = {}, dropped = {} }) {
  const pids = new Set([...Object.keys(kept), ...Object.keys(dropped)]);
  const out = {};
  for (const p of pids) out[p] = ((kept[p] || 0) + 1) / ((kept[p] || 0) + (dropped[p] || 0) + 1);
  return out;
}

export function autoAllocate({ games, umpires, availByEmail, baseLoads = {}, claimOf, reliability = {} }) {
  const active = umpires.filter(u => u.active);
  const busy = buildBusyMap(games);
  const loads = { ...baseLoads };
  for (const [p, n] of Object.entries(recount(games).byUmpire)) loads[p] = (loads[p] || 0) + n;
  const working = new Map(games.map(g => [g.id, { ...g, alloc: structuredClone(g.alloc || {}) }]));
  const changes = [];

  const ordered = [...games].filter(g => slotCount(g) > 0).sort(compareGames);
  for (const orig of ordered) {
    const g = working.get(orig.id);
    let prevPid = null;
    const comp = compKeyOf(g);
    for (const d of g.days) {
      const bk = availKey(comp, d.date);
      const cur = allocFor(g, d.date);
      for (let i = 0; i < cur.length; i++) {
        if (cur[i]) { prevPid = cur[i].p; continue; }
        // The player umpire who chose this game goes back in first, if they are not in it.
        const chooser = claimOf && active.find(u => claimOf(u.pid, d.date, comp) === g.id && !allocFor(g, d.date).some(a => a && a.p === u.pid));
        if (chooser) {
          const entry = { p: chooser.pid, n: chooser.name, pu: true };
          (g.alloc[d.date] ||= [])[i] = entry;
          ((busy[bk] ||= {})[chooser.pid] ||= []).push(g.id);
          loads[chooser.pid] = (loads[chooser.pid] || 0) + 1;
          changes.push({ gameId: g.id, date: d.date, slot: i, entry });
          prevPid = chooser.pid;
          continue;
        }
        const cands = active.filter(u =>
          availStatus(availByEmail, u, comp, d.date) === 'yes' &&
          !(claimOf && claimOf(u.pid, d.date, comp)) &&                // player umpires keep to the game they chose
          !((busy[bk] || {})[u.pid] || []).length &&
          !allocFor(g, d.date).some(a => a && a.p === u.pid));
        if (!cands.length) continue;
        // Most reliable first (kept their published games), then fewest games so far, so work is shared.
        const rel = u => (u.pid in reliability ? reliability[u.pid] : 1);
        cands.sort((a, b) =>
          rel(b) - rel(a) ||
          (loads[a.pid] || 0) - (loads[b.pid] || 0) ||
          (b.pid === prevPid) - (a.pid === prevPid) ||
          a.name.localeCompare(b.name));
        // keep the same umpire across a two-day game when that is fair enough
        const same = prevPid && cands.find(u => u.pid === prevPid);
        const pick = same && rel(same) >= rel(cands[0]) && (loads[same.pid] || 0) <= (loads[cands[0].pid] || 0) + 1 ? same : cands[0];
        const entry = { p: pick.pid, n: pick.name };
        (g.alloc[d.date] ||= [])[i] = entry;
        ((busy[bk] ||= {})[pick.pid] ||= []).push(g.id);
        loads[pick.pid] = (loads[pick.pid] || 0) + 1;
        changes.push({ gameId: g.id, date: d.date, slot: i, entry });
        prevPid = pick.pid;
      }
    }
  }
  return changes;
}

export function applyChanges(game, changes) {
  const alloc = structuredClone(game.alloc || {});
  for (const c of changes.filter(c => c.gameId === game.id)) {
    const arr = (alloc[c.date] ||= []);
    while (arr.length <= c.slot) arr.push(null);
    arr[c.slot] = c.entry;
  }
  return alloc;
}

// Text for the "umpires" column in the report.
export function umpireText(game) {
  if (!slotCount(game)) return '';
  const days = game.days;
  const per = days.map(d => allocFor(game, d.date).map(a => (a && a.n ? a.n + (a.pu ? ' (Player umpire)' : '') : null)));
  if (days.length === 1) return per[0].map(n => n || '—').join(' & ').toUpperCase();
  const sameAll = per.every(p => JSON.stringify(p) === JSON.stringify(per[0]));
  if (sameAll) return per[0].map(n => n || '—').join(' & ').toUpperCase();
  return per.map((p, i) => `${p.map(n => n || '—').join(' & ')} (Day ${days[i].day})`).join(' / ').toUpperCase();
}

// ---------- season calendar (what umpires see) ----------------------------

// Each competition is shown to umpires in one of two layouts, chosen from its fixtures:
//  * "rounds": when every game in the competition has the same length (all two-day, or all
//    one-day) the familiar Round 2 -> Day 1 / Day 2 layout is clear, so it is used.
//  * "dates":  when game lengths are mixed (Juniors: day 2 of a U14 two-day round can be a
//    one-day round for U13) round labels would be ambiguous, so umpires just get a plain list
//    of dates. Availability is per date either way.
// Calendar entries: rounds layout -> { comp, label, dates } per round; dates layout -> one
// { comp, dates } entry with no label.
export function buildCalendar(games) {
  const byComp = new Map();
  for (const g of games) { const k = compKeyOf(g); if (!byComp.has(k)) byComp.set(k, []); byComp.get(k).push(g); }
  const out = [];
  for (const { key } of COMPS) {
    const list = byComp.get(key);
    if (!list) continue;
    const uniform = new Set(list.map(g => g.days.length)).size === 1;
    if (!uniform) {
      out.push({ comp: key, dates: [...new Set(list.flatMap(g => g.days.map(d => d.date)))].sort() });
      continue;
    }
    // Uniform: group dates into rounds. When grades disagree about a date's round number
    // (byes shift numbering) the most common name wins.
    const names = new Map(); // date -> Map(name -> n)
    for (const g of list) for (const d of g.days) {
      const m = names.get(d.date) || names.set(d.date, new Map()).get(d.date);
      m.set(g.roundName, (m.get(g.roundName) || 0) + 1);
    }
    const groups = new Map();
    for (const [date, m] of names) {
      const round = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))[0][0];
      if (!groups.has(round)) groups.set(round, []);
      groups.get(round).push(date);
    }
    // Every game is `n` days long, so a round is `n` consecutive dates (a name reused later in the
    // season starts a new round rather than extending this one).
    const n = list[0].days.length;
    const rounds = [];
    for (const [round, dates] of groups) {
      dates.sort();
      for (let i = 0; i < dates.length; i += n) rounds.push({ round, dates: dates.slice(i, i + n) });
    }
    rounds.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
    const seen = {};
    for (const r of rounds) {
      const base = r.round || 'Games';
      seen[base] = (seen[base] || 0) + 1;
      out.push({ comp: key, label: seen[base] > 1 ? `${base} (${seen[base]})` : base, dates: r.dates });
    }
  }
  return out;
}

// What the umpire page needs, per competition in Senior, T20, Junior order, from `today` on:
//   { comp, label, mode: 'rounds', rounds: [{ label, rows: [{ date, dayNo, of }] }], dates }
//   { comp, label, mode: 'dates',  rounds: [],                                       dates }
export function upcomingDates(calendar, today) {
  const by = new Map();
  for (const r of calendar || []) { const k = r.comp || 'senior'; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return COMPS.filter(c => by.has(c.key)).map(c => {
    const entries = by.get(c.key);
    if (entries.every(e => e.label)) {
      const rounds = entries.map(e => ({
        label: e.label,
        rows: e.dates.map((date, i) => ({ date, dayNo: i + 1, of: e.dates.length })).filter(x => x.date >= today),
      })).filter(r => r.rows.length);
      return { comp: c.key, label: c.label, mode: 'rounds', rounds, dates: rounds.flatMap(r => r.rows.map(x => x.date)) };
    }
    const dates = [...new Set(entries.flatMap(e => e.dates))].filter(d => d >= today).sort();
    return { comp: c.key, label: c.label, mode: 'dates', rounds: [], dates };
  }).filter(c => c.dates.length);
}

// [{ month: 'November 2026', dates: [...] }] for a sorted list of ISO dates.
export function byMonth(dates) {
  const out = [];
  for (const d of dates) {
    const key = d.slice(0, 7);
    if (!out.length || out[out.length - 1].key !== key) {
      out.push({ key, month: new Date(d + 'T00:00:00Z').toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }), dates: [] });
    }
    out[out.length - 1].dates.push(d);
  }
  return out;
}

// ---------- ids -----------------------------------------------------------

// Members are stored with a first and last name. `name` is kept as the full name because the
// allocation board, dropdowns, reports and saved allocations all use it. Records made before
// the two fields existed have only `name`, so split it for display.
export function nameParts(u = {}) {
  if (u.firstName || u.lastName) return { firstName: u.firstName || '', lastName: u.lastName || '' };
  const bits = (u.name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: bits.shift() || '', lastName: bits.join(' ') };
}
export const fullName = (first, last) => `${(first || '').trim()} ${(last || '').trim()}`.trim();
// Sort a member list by last name, then first name.
export function compareMembers(a, b) {
  const x = nameParts(a), y = nameParts(b);
  return (x.lastName || '').localeCompare(y.lastName || '') || (x.firstName || '').localeCompare(y.firstName || '');
}

export function newPid() {
  const a = new Uint8Array(8);
  (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256)));
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function emailKey(email) { return (email || '').trim().toLowerCase(); }
