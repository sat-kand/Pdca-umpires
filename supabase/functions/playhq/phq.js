// PlayHQ fixture service: pure logic, no Deno APIs, so Node can test it (tests/playhq.test.mjs).
//
// The browser never talks to PlayHQ and never sees the key. This turns PlayHQ's answers into the JSON
// shape the app already reads (seasons -> competitions with grades -> matches), so the app's own
// fixture code and tests are unchanged.

export class PhqError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = s => UUID.test(String(s || ''));

export const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- PlayHQ HTTP client ----------

export function makePhq({ key, tenant = 'ca', base = 'https://api.playhq.com', fetchFn = globalThis.fetch }) {
  async function get(path, cursor) {
    const url = base + path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchFn(url, { headers: { 'x-api-key': key, 'x-phq-tenant': tenant, accept: 'application/json' } });
      if (res.ok || attempt >= 2 || ![429, 500, 502, 503, 504].includes(res.status)) break;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
    if (res.status === 404) throw new PhqError('PlayHQ has nothing at that ID', 404);
    if (res.status === 401 || res.status === 403) throw new PhqError('PlayHQ did not accept the key for that request', res.status);
    if (!res.ok) throw new PhqError(`PlayHQ returned ${res.status}`, res.status);
    return res.json();
  }
  async function all(path) {                                     // follows PlayHQ's pages to the end
    const out = [];
    let cursor;
    for (let i = 0; i < 50; i++) {
      const j = await get(path, cursor);
      out.push(...(j.data || []));
      if (!j.metadata || !j.metadata.hasMore || !j.metadata.nextCursor) break;
      cursor = j.metadata.nextCursor;
    }
    return out;
  }
  return {
    seasons: orgId => all(`/v1/organisations/${orgId}/seasons`),
    grades: seasonId => all(`/v1/seasons/${seasonId}/grades`),
    games: gradeId => get(`/v2/grades/${gradeId}/games`),
  };
}

// Remember seasons and grades for a few minutes, so a Refresh is not dozens of PlayHQ calls.
export function cachedPhq(phq, { ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const memo = new Map();
  const hold = (k, fn) => {
    const hit = memo.get(k);
    if (hit && now() - hit.at < ttlMs) return hit.p;
    const p = fn().catch(e => { memo.delete(k); throw e; });
    memo.set(k, { at: now(), p });
    return p;
  };
  return { seasons: id => hold('s' + id, () => phq.seasons(id)), grades: id => hold('g' + id, () => phq.grades(id)), games: id => phq.games(id) };
}

// ---------- seasons ----------
// PlayHQ has one "season" per competition, and several can share a name (Summer 2026/27 for Senior,
// Junior and T20). The app has one season holding several competitions, so they are grouped by name.

export function groupSeasons(list) {
  const by = new Map();
  for (const s of list || []) {
    const name = String(s.name ?? '');
    const id = slug(name) || 'season';
    if (!by.has(id)) by.set(id, { id, name, current: false, start: '', members: [] });
    const g = by.get(id);
    g.members.push({ phqId: s.id, competition: s.competition || null });
    if (String(s.status || '').toUpperCase() === 'ACTIVE') g.current = true;
    if ((s.createdAt || '') > g.start) g.start = s.createdAt;
  }
  return [...by.values()].sort((a, b) => (b.current - a.current) || b.start.localeCompare(a.start));
}

export const legacySeasons = groups => ({
  seasons: groups.map(g => ({ id: g.id, name: g.name, isCurrentSeason: g.current, startDate: g.start })),
});

// Grade ids are "<PlayHQ season id>.<PlayHQ grade id>", so a later request can check the grade
// belongs to this association without being told which season it is in.
export async function legacyCompetitions(group, phq) {
  const lists = await Promise.all(group.members.map(m => phq.grades(m.phqId)));
  return {
    competitionSeasons: group.members.map((m, i) => ({
      competition: { id: (m.competition && m.competition.id) || m.phqId, name: (m.competition && m.competition.name) || group.name },
      grades: (lists[i] || []).map(g => ({ id: `${m.phqId}.${g.id}`, name: g.name })),
    })),
  };
}

// ---------- matches ----------

const TYPES = { oneday: 'One Day', twoday: 'Two Day', t20: 'T20' };
export const matchTypeOf = t => TYPES[String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || String(t || '');

const STATUS = { FINAL: 'COMPLETED' };
export const statusOf = s => { const u = String(s || '').toUpperCase(); return STATUS[u] || u; };

// "2026-10-10T02:30:00.000Z" at a ground in Australia/Sydney -> "2026-10-10T13:30:00.0000000+11:00"
export function localStamp(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = zone => new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let f;
  try { f = fmt(tz || 'Australia/Sydney'); } catch { f = fmt('Australia/Sydney'); }
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const a = Math.abs(off);
  const sign = off < 0 ? '-' : '+';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.0000000${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// PlayHQ's games for one grade (rounds -> games) -> { matches: [...] } in the app's shape.
// Byes are not games, and a game with no date yet (a final not drawn) is left out until it has one.
export function legacyMatches(v2) {
  const teamName = new Map(((v2 && v2.teams) || []).map(t => [t.id, t.name]));
  const surface = new Map(((v2 && v2.playingSurfaces) || []).map(s => [s.id, s]));
  const matches = [];
  for (const round of (v2 && v2.rounds) || []) {
    for (const g of round.games || []) {
      const sched = (g.schedule || []).filter(s => s && s.dateTime).sort((a, b) => (a.day ?? 0) - (b.day ?? 0) || String(a.dateTime).localeCompare(String(b.dateTime)));
      if (!sched.length) continue;
      const ps = surface.get(sched[0].playingSurfaceId) || {};
      const venue = ps.venue || {};
      const addr = venue.address || {};
      const matchSchedule = sched.map((s, i) => {
        const where = (surface.get(s.playingSurfaceId) || {}).venue || {};
        return { matchDay: i + 1, startDateTime: localStamp(s.dateTime, where.timezone || venue.timezone) };
      }).filter(s => s.startDateTime);
      if (!matchSchedule.length) continue;
      matches.push({
        id: g.id,
        status: statusOf(g.status),
        matchType: matchTypeOf(g.type),
        round: { id: round.id, name: round.name || '', shortName: round.abbreviatedName || '' },
        matchSchedule,
        venue: {
          name: venue.name || '', line1: addr.line1 || '', suburb: addr.suburb || '',
          playingSurface: { name: ps.name || '', latitude: ps.latitude ?? null, longitude: ps.longitude ?? null },
        },
        teams: (g.teams || []).map(t => ({ id: t.id, displayName: teamName.get(t.id) || 'TBC', isHome: !!t.isHomeTeam, owningOrganisation: { name: '' } })),
      });
    }
  }
  return { matches };
}

// ---------- one request ----------
// action: check | seasons | competitions | matches. orgId is the association's PlayHQ organisation.

export async function run(action, params, phq, orgId) {
  if (action === 'check') {
    let seasons;
    try { seasons = await phq.seasons(orgId); } catch (e) {
      if (e instanceof PhqError && e.status === 404) return { ok: false, error: 'PlayHQ has no organisation with that ID. Check it and try again.' };
      throw e;
    }
    if (!seasons.length) return { ok: false, error: 'PlayHQ knows that ID but it has no seasons yet. Check it is the association, not a club.' };
    const groups = groupSeasons(seasons);
    const assoc = seasons.find(s => s.association && s.association.name);
    return { ok: true, name: assoc ? assoc.association.name : '', seasons: groups.map(g => g.name), current: groups.filter(g => g.current).map(g => g.name) };
  }
  if (action === 'seasons') return legacySeasons(groupSeasons(await phq.seasons(orgId)));
  if (action === 'competitions') {
    const group = groupSeasons(await phq.seasons(orgId)).find(g => g.id === String(params.seasonId || ''));
    if (!group) throw new PhqError('That season is not in this association', 404);
    return legacyCompetitions(group, phq);
  }
  if (action === 'matches') {
    const [seasonId, gradeId] = String(params.gradeId || '').split('.');
    if (!isUuid(seasonId) || !isUuid(gradeId)) throw new PhqError('That grade is not valid', 400);
    const own = (await phq.seasons(orgId)).some(s => s.id === seasonId);
    if (!own) throw new PhqError('That grade is not in this association', 403);
    const grades = await phq.grades(seasonId);
    if (!grades.some(g => g.id === gradeId)) throw new PhqError('That grade is not in this association', 403);
    return legacyMatches(await phq.games(gradeId));
  }
  if (action === 'matchesMany') {                                // every grade in one request: sign-in and ownership are checked once
    const ids = [...new Set(Array.isArray(params.gradeIds) ? params.gradeIds.map(String) : [])];
    if (!ids.length || ids.length > 300) throw new PhqError('That list of grades is not valid', 400);
    const pairs = ids.map(id => id.split('.'));
    if (pairs.some(([s, g]) => !isUuid(s) || !isUuid(g))) throw new PhqError('That grade is not valid', 400);
    const owned = new Set((await phq.seasons(orgId)).map(s => s.id));
    const seasonIds = [...new Set(pairs.map(([s]) => s))];
    if (seasonIds.some(s => !owned.has(s))) throw new PhqError('That grade is not in this association', 403);
    const gradesOf = new Map(await pool(seasonIds, 6, async s => [s, new Set((await phq.grades(s)).map(g => g.id))]));
    if (pairs.some(([s, g]) => !gradesOf.get(s).has(g))) throw new PhqError('That grade is not in this association', 403);
    const lists = await pool(ids, 8, async id => [id, legacyMatches(await phq.games(id.split('.')[1]))]);
    return { grades: Object.fromEntries(lists) };
  }
  throw new PhqError('Unknown request', 400);
}

// Run fn over items, at most `limit` at a time; results in input order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
