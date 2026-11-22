// Fixture import: the PlayHQ service (through the app's `playhq` Edge Function), plus a CSV fallback.

import { sectionKey } from './logic.js';

// Live back-end: the app asks the `playhq` Edge Function (which holds the PlayHQ key and reads the
// association's organisation ID itself). The function answers in the same shape as the paths below.
export function makePlayhqApi(store) {
  const api = async function api(path) {
    const [p, qs = ''] = path.split('?');
    let m;
    if (/\/seasons$/.test(p)) return store.playhq('seasons');
    if (/\/competition-seasons$/.test(p)) return store.playhq('competitions', { seasonId: new URLSearchParams(qs).get('seasonId') });
    if ((m = /\/grades\/([^/]+)\/matches$/.exec(p))) return store.playhq('matches', { gradeId: decodeURIComponent(m[1]) });
    throw new Error('Unsupported fixture request: ' + p);
  };
  api.many = async gradeIds => (await store.playhq('matchesMany', { gradeIds })).grades || {};   // all grades in one trip
  return api;
}

// Only the live store has `playhq`. Demo mode has no fixture service: its fixtures are made up when sample data is loaded.
export function fixtureApi(store) {
  if (!store || !store.playhq) throw new Error('Fixtures can only be loaded from PlayHQ once the app is set up with a database');
  return makePlayhqApi(store);
}

export async function fetchSeasons(api, orgId) {
  const j = await api(`/fixturesladders/organisations/${orgId}/seasons`);
  return (j.seasons || []).map(s => ({ id: s.id, name: s.name, current: !!s.isCurrentSeason, start: s.startDate }));
}

// -> [{ id, name, grades:[{id,name}] }]
export async function fetchCompetitions(api, orgId, seasonId) {
  const j = await api(`/fixturesladders/organisations/${orgId}/competition-seasons?seasonId=${seasonId}&responseModifier=includeGrades`);
  return (j.competitionSeasons || []).map(c => ({
    id: c.competition.id,
    name: c.competition.name,
    grades: (c.grades || []).map(g => ({ id: g.id, name: g.name })),
  }));
}

export function normaliseMatch(m, grade, comp) {
  if (!m || m.matchType === 'BYE' || !Array.isArray(m.matchSchedule) || !m.matchSchedule.length) return null;
  const days = [...m.matchSchedule]
    .sort((a, b) => a.matchDay - b.matchDay)
    .map(s => ({ day: s.matchDay, date: s.startDateTime.slice(0, 10), time: s.startDateTime.slice(11, 16) }));
  const home = (m.teams || []).find(t => t.isHome) || (m.teams || [])[0];
  const away = (m.teams || []).find(t => t !== home);
  const v = m.venue || {};
  const surface = v.playingSurface && v.playingSurface.name;
  const ground = !surface ? (v.name || '') : (!v.name || surface.toLowerCase().startsWith(v.name.toLowerCase()) ? surface : `${v.name} – ${surface}`);
  const team = t => ({ name: (t && t.displayName) || 'TBC', org: (t && t.owningOrganisation && t.owningOrganisation.name) || '' });
  return {
    id: m.id,
    comp: comp.name,
    compId: comp.id || '',
    grade: grade.name,
    roundName: (m.round && m.round.name) || '',
    matchType: m.matchType || '',
    status: m.status || '',
    days,
    home: team(home),
    away: team(away),
    ground,
    address: [v.line1, v.suburb].filter(Boolean).join(', '),
    lat: (v.playingSurface && v.playingSurface.latitude) ?? null,
    lng: (v.playingSurface && v.playingSurface.longitude) ?? null,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// All games for the chosen competitions whose FIRST day falls within [from, to].
export async function loadFixtures({ api, comps, from, to, onProgress }) {
  const grades = comps.flatMap(c => c.grades.map(g => ({ grade: g, comp: c })));
  let done = 0;
  if (api.many && grades.length) {
    const byId = await api.many(grades.map(x => x.grade.id));
    onProgress && onProgress(grades.length, grades.length);
    const out = grades.flatMap(({ grade, comp }) => ((byId[grade.id] || {}).matches || []).map(m => normaliseMatch(m, grade, comp)).filter(Boolean));
    return out.filter(g => g.days[0].date >= from && g.days[0].date <= to);
  }
  const lists = await mapLimit(grades, 4, async ({ grade, comp }) => {
    const j = await api(`/scores/grades/${grade.id}/matches`);
    onProgress && onProgress(++done, grades.length);
    return (j.matches || []).map(m => normaliseMatch(m, grade, comp)).filter(Boolean);
  });
  return lists.flat().filter(g => g.days[0].date >= from && g.days[0].date <= to);
}

// ---------- CSV fallback --------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

export function parseDate(s) {
  const t = (s || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t))) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

const HEADERS = {
  grade: ['grade'], home: ['home', 'home team'], away: ['away', 'away team'],
  ground: ['ground', 'venue'], date1: ['date', 'day 1', 'day1', 'date 1', 'date1'],
  date2: ['day 2', 'day2', 'date 2', 'date2'], time: ['time', 'start'], round: ['round'], comp: ['competition', 'comp'],
};

// CSV columns: grade, home, away, ground, date [, day 2 date, time, round, competition]
export function gamesFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file needs a header row and at least one fixture.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADERS)) col[k] = head.findIndex(h => names.includes(h));
  for (const need of ['grade', 'home', 'away', 'date1']) {
    if (col[need] < 0) throw new Error(`Missing column: ${need === 'date1' ? 'date' : need}`);
  }
  const games = [];
  const errors = [];
  rows.slice(1).forEach((r, i) => {
    const get = k => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
    const d1 = parseDate(get('date1'));
    if (!d1) { errors.push(`Row ${i + 2}: date not understood ("${get('date1')}")`); return; }
    const d2 = get('date2') ? parseDate(get('date2')) : null;
    const time = /^\d{1,2}:\d{2}/.test(get('time')) ? get('time').padStart(5, '0').slice(0, 5) : '';
    const days = [{ day: 1, date: d1, time }];
    if (d2) days.push({ day: 2, date: d2, time });
    const home = get('home'), away = get('away'), grade = get('grade');
    games.push({
      id: 'csv-' + simpleHash([grade, home, away, d1].join('|')),
      comp: get('comp') || 'Imported',
      grade,
      roundName: get('round') || 'Round',
      matchType: d2 ? 'Two Day' : 'One Day',
      status: '',
      days,
      home: { name: home, org: '' },
      away: { name: away, org: '' },
      ground: get('ground'),
      address: '', lat: null, lng: null,
    });
  });
  return { games, errors };
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- merging a re-import into existing games -----------------------

const FIXTURE_FIELDS = ['comp', 'grade', 'roundName', 'matchType', 'status', 'days', 'home', 'away', 'ground', 'address', 'lat', 'lng'];

function changeNotes(old, neu) {
  const notes = [];
  if (old.ground !== neu.ground) notes.push(`Ground: ${old.ground || '?'} → ${neu.ground || '?'}`);
  const od = old.days.map(d => d.date + ' ' + d.time).join(', ');
  const nd = neu.days.map(d => d.date + ' ' + d.time).join(', ');
  if (od !== nd) notes.push(`Date/time: ${od} → ${nd}`);
  if (old.home.name !== neu.home.name || old.away.name !== neu.away.name) notes.push('Teams changed');
  return notes;
}

// existing: games already stored; fresh: newly fetched. Keeps slots/alloc.
// Returns { games (to write), added, changed, removed } where removed games stay but are flagged.
// JSON with the keys sorted, so a game read back from the database (whose keys come in another order) equals the same game as fetched.
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);

const GONE_NOTE = 'No longer in the fixture list';

export function mergeFixtures(existing, fresh, defaultSlots = () => 1) {
  const byId = new Map(existing.map(g => [g.id, g]));
  const seen = new Set();
  const out = [];
  let added = 0, changed = 0, removed = 0;
  for (const f of fresh) {
    seen.add(f.id);
    const old = byId.get(f.id);
    if (!old) {
      out.push({ ...f, slots: defaultSlots(f), alloc: {} });
      added++;
      continue;
    }
    const notes = changeNotes(old, f);
    const merged = { ...old };
    for (const k of FIXTURE_FIELDS) merged[k] = f[k];
    if (old.removed) merged.removed = false;                  // (a game that was never removed reads back as null, not false)
    if (old.changeNote === GONE_NOTE) merged.changeNote = '';  // it is in the list again: the warning no longer applies
    if (notes.length) { merged.changeNote = notes.join('; '); changed++; }
    if (canon(merged) !== canon(old)) out.push(merged);
  }
  for (const old of existing) {
    if (!seen.has(old.id) && !old.removed && !old.manual) {
      out.push({ ...old, removed: true, changeNote: GONE_NOTE });
      removed++;
    }
  }
  return { games: out, added, changed, removed };
}

export function sectionsOf(games) {
  const map = new Map();
  for (const g of games) {
    const k = sectionKey(g);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(g);
  }
  return map;
}
