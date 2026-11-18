// Bringing a season's availability in from the spreadsheet an association already keeps
// (the Google Form responses), so umpires do not have to answer everything again.
//
// The sheet looks like this — one row per umpire, one column per round:
//
//   Name              | Round 1 - 20th & 27th Sep | Round 2 - 11th & 18th Oct | Round 5 : 22nd Nov
//   Gerry             | Day 1, Day 2              | Day 2                     | Yes
//   Naresh Narendiran | Not Available             | Not Available             | No
//
// Columns are matched to the season calendar by their round name, or by the dates written in
// the heading. Rows are matched to members by name (or by an email column, if there is one).

import { parseCsv } from './fixtures.js';
import { availKey, nameParts, fullName, firstGroup } from './logic.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const EMAIL_RE = /[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+/;

// The dates of one competition in the season calendar, with the round labels they belong to.
export function calendarFor(season, comp) {
  const entries = ((season && season.calendar) || []).filter(e => (e.comp || firstGroup()) === comp);
  const dates = [...new Set(entries.flatMap(e => e.dates))].sort();
  const rounds = entries.filter(e => e.label).map(e => ({ label: e.label, dates: [...e.dates].sort() }));
  return { dates, rounds };
}

// 'Round 1 - 20th & 27th Sep' -> the dates of that round, or the dates written in the heading.
export function datesForHeading(heading, { dates, rounds }) {
  const h = norm(heading);
  if (!h) return [];
  const r = /round\s*(\d+)/.exec(h);
  if (r) {
    const hit = rounds.find(x => norm(x.label) === `round ${r[1]}`);
    if (hit) return hit.dates;
  }
  // Day numbers and month names, in the order they are written: '25th Oct & 1st Nov' -> 25 Oct, 1 Nov.
  const tokens = [...h.matchAll(/(\d{1,2})(?:st|nd|rd|th)?|([a-z]{3,})/g)]
    .map(m => (m[1] ? { day: Number(m[1]) } : { month: MONTHS.indexOf(m[2].slice(0, 3)) }))
    .filter(t => t.day ? t.day >= 1 && t.day <= 31 : t.month >= 0);
  const out = [];
  tokens.forEach((t, i) => {
    if (!t.day) return;
    const after = tokens.slice(i).find(x => x.month >= 0) || [...tokens].reverse().find(x => x.month >= 0);
    if (!after) return;
    const hit = dates.find(d => Number(d.slice(8, 10)) === t.day && Number(d.slice(5, 7)) === after.month + 1);
    if (hit && !out.includes(hit)) out.push(hit);
  });
  return out.sort();
}

// 'Day 1, Day 2' / 'Day 2' / 'Not Available' / 'Yes' -> an answer for each date of that column.
export function answersFor(cell, dates) {
  const v = norm(cell);
  if (!v || !dates.length) return { answers: {}, known: !v };
  if (/^(n|no|not available|unavailable|not avail\.?)$/.test(v) || v.includes('not available')) {
    return { answers: Object.fromEntries(dates.map(d => [d, 'no'])), known: true };
  }
  const days = [...v.matchAll(/day\s*(\d)/g)].map(m => Number(m[1]));
  if (days.length) {
    return { answers: Object.fromEntries(dates.map((d, i) => [d, days.includes(i + 1) ? 'yes' : 'no'])), known: true };
  }
  if (/^(y|yes|available|avail\.?|both)$/.test(v) || v.includes('available')) {
    return { answers: Object.fromEntries(dates.map(d => [d, 'yes'])), known: true };
  }
  return { answers: {}, known: false };                 // something we do not understand: left alone
}

const keyOf = u => {
  const n = nameParts(u);
  return norm(fullName(n.firstName, n.lastName) || u.name);
};

// A sheet pasted from Google Sheets or Excel is tab-separated, and its cells often contain commas
// ("Day 1, Day 2"), so tabs win when there are any. Otherwise it is read as CSV.
export function parseTable(text) {
  const t = (text || '').replace(/^\ufeff/, '');
  if (!t.includes('\t')) return parseCsv(t);
  return t.split(/\r?\n/).map(line => line.split('\t')).filter(r => r.some(c => c.trim() !== ''));
}

// Work out what a pasted sheet would do, without changing anything.
export function planImport({ text, comp, season, members = [], availability = [] }) {
  const rows = parseTable(text);
  if (rows.length < 2) return { error: 'Paste the heading row and at least one umpire.', columns: [], people: [] };

  const cal = calendarFor(season, comp);
  if (!cal.dates.length) return { error: 'This competition has no dates in the season calendar yet.', columns: [], people: [] };

  const head = rows[0].map(c => (c || '').trim());
  const emailCol = head.findIndex(c => /e-?mail/i.test(c));
  const columns = head.map((heading, i) => ({ i, heading, dates: i === 0 || i === emailCol ? [] : datesForHeading(heading, cal) }));
  const used = columns.filter(c => c.dates.length);

  const byName = new Map(members.map(u => [keyOf(u), u]));
  const byEmail = new Map(members.map(u => [norm(u.email), u]));
  const existing = new Map(availability.map(a => [norm(a.email), a]));

  const people = [];
  for (const row of rows.slice(1)) {
    const name = (row[0] || '').trim();
    const email = emailCol >= 0 ? (row[emailCol] || '').trim() : (EMAIL_RE.exec(name) || [''])[0];
    if (!name && !email) continue;
    const member = (email && byEmail.get(norm(email))) || byName.get(norm(name)) || null;
    const days = {};
    let yes = 0, no = 0, unknown = 0;
    for (const c of used) {
      const { answers, known } = answersFor(row[c.i], c.dates);
      if (!known) { unknown++; continue; }
      for (const [d, v] of Object.entries(answers)) { days[availKey(comp, d)] = v; if (v === 'yes') yes++; else no++; }
    }
    people.push({ name: name || email, email: (email || (member && member.email) || '').toLowerCase(), member, days, yes, no, unknown,
      had: !!(member && existing.get(norm(member.email))) });
  }
  return {
    error: '', columns, used, dates: cal.dates,
    unmatchedColumns: columns.filter(c => c.i > 0 && c.i !== emailCol && !c.dates.length).map(c => c.heading).filter(Boolean),
    people,
    matched: people.filter(p => p.member).length,
    strangers: people.filter(p => !p.member),
  };
}

// Write the plan. People who are not members are added as inactive ones when `addStrangers` is set,
// so their answers are kept and they show up as "Available Non-Member" when allocating.
export async function applyImport(store, plan, { comp, season, addStrangers = false, newPid }) {
  let saved = 0, added = 0, skipped = 0, noEmail = 0;
  for (const p of plan.people) {
    if (!Object.keys(p.days).length) { skipped++; continue; }
    let member = p.member;
    if (!member) {
      if (!addStrangers) { skipped++; continue; }
      if (!p.email) { noEmail++; skipped++; continue; }          // a person can only be added with an email address
      const parts = p.name.replace(EMAIL_RE, '').trim().split(/\s+/).filter(Boolean);
      member = { pid: newPid(), email: p.email.toLowerCase(), firstName: parts[0] || p.email, lastName: parts.slice(1).join(' '),
        name: p.name.replace(EMAIL_RE, '').trim() || p.email, phone: '', active: false, nonMember: true, updatedAt: new Date().toISOString() };
      await store.saveUmpire(member);
      added++;
    }
    const had = await store.getAvailability(season.id, member.email);
    const days = { ...((had && had.days) || {}), ...p.days };    // other competitions and dates are left alone
    await store.saveAvailability({ seasonId: season.id, email: member.email, name: member.name, days,
      importedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    saved++;
  }
  return { saved, added, skipped, noEmail };
}
