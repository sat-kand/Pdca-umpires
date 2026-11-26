// Pure converters between the app's document-shaped objects and the Supabase tables.
// No network, no DOM: unit-tested in tests/supabase-map.test.mjs.

const PERSON_F = ['firstName', 'lastName', 'name', 'dob', 'address', 'phone', 'accreditation', 'accreditationProvider'];
const MEMBER_F = ['answers', 'membership', 'memberSince', 'wantsToUmpire', 'approved', 'deactivated', 'nonMember', 'rejected', 'suspended', 'active'];
const snake = k => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const blank = v => (v === '' ? null : v);
const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ----- association -----
const ORG_COLS = ['id', 'name', 'playhqOrgId', 'notifyEmail', 'plan', 'weekStart', 'createdBy'];
export function orgToRow(o) {
  const row = { config: {} };
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (ORG_COLS.includes(k)) row[snake(k)] = v;
    else row.config[k] = v;
  }
  return row;
}
export function rowToOrg(r) {
  if (!r) return null;
  return defined({
    ...(r.config || {}), id: r.id, name: r.name, playhqOrgId: r.playhq_org_id || '', notifyEmail: r.notify_email || '',
    plan: r.plan, weekStart: r.week_start, createdBy: r.created_by || undefined,
  });
}

// ----- umpire = person + membership -----
export const personRow = u => defined({ email: u.email, ...Object.fromEntries(PERSON_F.filter(k => k in u).map(k => [snake(k), blank(u[k])])) });
export function membershipRow(aid, u) {
  const row = { association_id: aid, email: u.email };
  if (u.pid !== undefined) row.pid = u.pid;
  for (const k of MEMBER_F) if (k in u && u[k] !== undefined) row[snake(k)] = blank(u[k]);
  return row;
}
export function rowToUmpire(m) {
  if (!m) return null;
  const p = m.people || {};
  const u = { pid: m.pid, email: m.email, active: !!m.active };
  for (const k of PERSON_F) if (p[snake(k)] != null) u[k] = p[snake(k)];
  for (const k of MEMBER_F) if (k !== 'active' && m[snake(k)] != null) u[k] = m[snake(k)];
  if (m.created_at) u.createdAt = m.created_at;                    // when they asked to join (read only: never written back)
  return u;
}

// ----- rounds -----
export function roundToRow(aid, r) {
  const { id, comp, title, start, end, published, ...rest } = r;
  return defined({ association_id: aid, id, comp, title, start_date: start || null, end_date: end || null, published, data: rest });
}
export const rowToRound = r => r && { ...(r.data || {}), id: r.id, comp: r.comp || undefined, title: r.title || '', start: r.start_date || undefined, end: r.end_date || undefined, published: !!r.published };

// ----- games: a game row, its day rows and its appointment rows -----
const GAME_KEYS = new Set(['id', 'grade', 'comp', 'roundName', 'matchType', 'home', 'away', 'status', 'slots', 'removed', 'playhqId', 'lastSyncedAt', 'days', 'alloc', 'ground', 'address', 'lat', 'lng']);
export function gameToItem(g) {
  const extra = Object.fromEntries(Object.entries(g).filter(([k]) => !GAME_KEYS.has(k)));
  if (g.home && g.home.org !== undefined) extra.homeOrg = g.home.org;
  if (g.away && g.away.org !== undefined) extra.awayOrg = g.away.org;
  const days = (g.days || []).map((d, i) => defined({
    day_no: d.day || i + 1, date: d.date, start_time: d.time || null,
    ground: d.ground !== undefined ? d.ground : g.ground, address: d.address !== undefined ? d.address : g.address,
    lat: d.lat !== undefined ? d.lat : g.lat, lng: d.lng !== undefined ? d.lng : g.lng,
  }));
  const appts = [];
  for (const [date, arr] of Object.entries(g.alloc || {})) {
    (arr || []).forEach((a, i) => { if (a && a.p) appts.push({ date, slot_index: i, pid: a.p, name: a.n || null, player_umpire: !!a.pu }); });
  }
  return {
    game: defined({
      id: g.id, grade: g.grade, comp: g.comp, round_name: g.roundName, format: g.matchType,
      home_name: g.home && g.home.name, away_name: g.away && g.away.name, status: g.status, slots: g.slots || 0,
      removed: !!g.removed, playhq_game_id: g.playhqId || null, last_synced_at: g.lastSyncedAt || null, extra,
    }),
    days, appts,
  };
}
// g: games row; days: its game_days rows; appts: its appointments rows
export function itemToGame(g, days = [], appts = []) {
  const { homeOrg, awayOrg, ...extra } = g.extra || {};
  const ds = [...days].sort((a, b) => a.day_no - b.day_no);
  const first = ds[0] || {};
  const out = {
    ...extra, id: g.id, grade: g.grade, comp: g.comp, roundName: g.round_name, matchType: g.format, status: g.status,
    home: { name: g.home_name, org: homeOrg !== undefined ? homeOrg : g.home_name },
    away: { name: g.away_name, org: awayOrg !== undefined ? awayOrg : g.away_name },
    ground: first.ground || '', address: first.address || '', lat: first.lat ?? null, lng: first.lng ?? null,
    days: ds.map(d => ({ day: d.day_no, date: d.date, time: d.start_time || '', ...(d.ground && d.ground !== first.ground ? { ground: d.ground } : {}) })),
    slots: g.slots || 0, alloc: {},
  };
  if (g.removed) out.removed = true;
  if (g.playhq_game_id) out.playhqId = g.playhq_game_id;
  const by = {};
  for (const a of appts) (by[a.date] ||= []).push(a);
  for (const [date, list] of Object.entries(by)) {
    const arr = Array.from({ length: Math.max(out.slots, ...list.map(a => a.slot_index + 1)) }, () => null);
    for (const a of list) arr[a.slot_index] = { p: a.pid, n: a.name || '', ...(a.player_umpire ? { pu: true } : {}) };
    out.alloc[date] = arr;
  }
  return out;
}

// ----- withdrawals -----
export const withdrawalToRow = (aid, w) => { const { id, email, pid, handled, ...rest } = w; return defined({ association_id: aid, id, email, pid, handled: handled === undefined ? undefined : !!handled, data: rest }); };
export const rowToWithdrawal = r => ({ ...(r.data || {}), id: r.id, email: r.email, pid: r.pid, handled: !!r.handled });

// ----- membership across associations -----
export const rowToMembershipLine = m => ({ orgId: m.association_id, orgName: (m.associations && m.associations.name) || m.association_id, membership: m.membership || '', active: !!m.active });

export { camel, snake };

// ----- where someone stands in each association (for the list of associations) -----
// A membership row's flags, as the app's umpire object would carry them (membershipOf reads these).
export const rowToStanding = m => ({ orgId: m.association_id, u: rowToUmpire({ ...m, pid: m.pid || '', email: m.email || '' }) });
