// Bringing in the membership list an association already keeps (a spreadsheet, or the responses of a
// Google Form), so its members do not have to apply again.
//
// The file has a heading row; columns are found by their names, in any order:
//
//   First name | Last name | Email | Mobile | Membership type | Member since
//   Jane       | Smith     | j.smith@example.com | 0400 000 000 | Ordinary member | 2019-04-15
//
// A single "Name" column works too. Everyone in the file becomes a member. Whether they are an Active
// umpire or an Inactive member is not taken from the file: it follows the availability they give (or that
// is brought in). A list with no heading row is read the old way: First name, Last name, email, mobile,
// accreditation no.
//
// Members already on the list (same email) keep their own details: only the association's part
// (membership type, member since) is updated, and only where the file says something.

import { parseTable } from './import-availability.js';
import { emailKey, fullName } from './logic.js';

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').trim();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Heading -> field. The first pattern that matches a heading wins; each field is taken once.
const FIELDS = [
  ['email', /e ?mail/],
  ['firstName', /^(first|given)( name)?$|first name|given name/],
  ['lastName', /^(last|sur|family)( ?name)?$|last name|surname|family name/],
  ['name', /^(full )?name$|member name|umpire name/],
  ['phone', /mobile|phone|contact (no|num)/],
  ['dob', /birth|dob|d\.?o\.?b/],
  ['address', /address|suburb/],
  ['accreditationProvider', /provider|accredited (by|with)|eligib|qualifi/],
  ['accreditation', /accreditation|accred|umpire (no|number)|card (no|number)|level/],
  ['membership', /membership( type)?|member type|type of membership|category/],
  ['memberSince', /since|joined|join date|start date|member from/],
  ['status', /status|active|umpir(e|ing)|role/],
];

// The fields a column can go to, as the admin sees them when matching columns.
export const MEMBER_FIELDS = [
  ['email', 'Email'], ['firstName', 'First name'], ['lastName', 'Last name'], ['name', 'Full name'], ['phone', 'Mobile'],
  ['dob', 'Date of birth'], ['address', 'Address'], ['accreditation', 'Accreditation no.'], ['accreditationProvider', 'Accreditation provider'],
  ['membership', 'Membership type'], ['memberSince', 'Member since'],
];
// Fields whose values can be translated one by one (a short list of answers, like a form's options).
export const VALUE_FIELDS = ['membership', 'accreditationProvider'];
export const headKey = hd => norm(hd);

// The columns of a sheet: a saved choice for a heading wins, then the guess from its name. Returns field -> column.
export function matchColumns(head, saved = {}) {
  const cols = {};
  head.forEach((hd, i) => {
    const k = headKey(hd);
    if (k in saved) { if (saved[k] && !(saved[k] in cols)) cols[saved[k]] = i; }
  });
  head.forEach((hd, i) => {
    if (headKey(hd) in saved || Object.values(cols).includes(i)) return;
    const n = norm(hd);
    for (const [field, re] of FIELDS) if (!(field in cols) && re.test(n)) { cols[field] = i; break; }
  });
  return cols;
}

// A sensible first translation for a provider answer from a form ('I have passed the NSWCUSA Course').
export function providerGuess(v) {
  const n = norm(v);
  if (/nswcusa|nsw cricket umpires/.test(n)) return 'NSW Cricket Umpires & Scorers Association';
  if (/cricket australia|\bca\b/.test(n)) return 'Cricket Australia';
  if (/cricket nsw/.test(n)) return 'Cricket NSW';
  const m = /passed the (.+?) course/.exec(n);
  if (m) return m[1].toUpperCase();
  return (v || '').trim();
}

// Australian mobiles that lost their leading 0 in a spreadsheet: 423387957 -> 0423387957.
export function phoneFrom(v) {
  const t = String(v || '').trim();
  return /^4\d{8}$/.test(t) ? '0' + t : /^614\d{8}$/.test(t) ? '0' + t.slice(2) : t;
}

export function columnsOf(head) {
  const cols = {};
  head.forEach((hd, i) => {
    const n = norm(hd);
    for (const [field, re] of FIELDS) if (!(field in cols) && re.test(n)) { cols[field] = i; break; }
  });
  return cols;
}

// 'Active' / 'Yes' / 'Umpire' -> true; 'Inactive' / 'No' / 'Member only' -> false; anything else -> null.
export function statusFrom(cell) {
  const v = norm(cell);
  if (!v) return null;
  if (/^(in ?active|no|n|false|member|member only|non umpir|not umpir|social|associate)/.test(v) || v.includes('inactive') || v.includes('not umpir')) return false;
  if (/^(active|yes|y|true|umpire|umpiring|current)/.test(v)) return true;
  return null;
}

// '15/04/2019', '2019-04-15', '15 Apr 2019', '2019' -> '2019-04-15' (a year alone -> 1 January); else ''.
export function dateFrom(cell) {
  const v = (cell || '').trim();
  if (!v) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v);          // Australian order: day first
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = /^(\d{4})$/.exec(v);
  if (m) return `${m[1]}-01-01`;
  m = /^(\d{5})(\.\d+)?$/.exec(v);                                // an Excel date number that came through as a number
  if (m) return new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86400000).toISOString().slice(0, 10);
  const t = Date.parse(v);
  if (!Number.isNaN(t)) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  return '';
}

// Work out what a membership file would do, without changing anything.
// rows (from a file) or text (pasted); cols overrides the column guess; values translates answers per field.
export function planMembers({ text, rows: given, cols: chosen, values = {}, members = [], types = [] }) {
  const rows = given || parseTable(text);
  if (!rows.length) return { error: 'Paste the list, or choose a file.', people: [] };
  let cols = chosen || columnsOf(rows[0]);
  let body = rows.slice(1);
  if (!('email' in cols)) {
    // No heading row: the old one-line-per-member format.
    if (rows[0].some(c => EMAIL.test((c || '').trim()))) { cols = null; body = rows; }
    else return { error: chosen ? 'Choose which column has the email address.' : 'No Email column found. The first row should be the headings, with one called Email.', people: [] };
  }
  const byEmail = new Map(members.map(u => [u.email, u]));
  const typeNames = new Map(types.map(t => [norm(t.name), t.name]));
  const seen = new Set();
  const people = [], bad = [];
  for (const row of body) {
    const get = f => {
      const raw = cols && f in cols ? String(row[cols[f]] || '').trim() : '';
      const map = values[f];
      return map && raw && norm(raw) in map ? map[norm(raw)] : raw;
    };
    let p;
    if (cols) {
      const email = emailKey(get('email'));
      let first = get('firstName'), last = get('lastName');
      if (!first && get('name')) { const parts = get('name').split(/\s+/); first = parts[0]; last = parts.slice(1).join(' '); }
      if (first && last && norm(first).endsWith(' ' + norm(last))) first = first.slice(0, first.length - last.length).trim();   // 'Jane Smith' | 'Smith'
      const type = get('membership');
      p = { email, firstName: first, lastName: last, phone: phoneFrom(get('phone')), dob: dateFrom(get('dob')), address: get('address'),
        accreditation: get('accreditation'), accreditationProvider: get('accreditationProvider'),
        membership: type ? (typeNames.get(norm(type)) || type) : '', unknownType: !!type && types.length > 0 && !typeNames.has(norm(type)),
        memberSince: dateFrom(get('memberSince')) };
    } else {
      const parts = row.map(c => (c || '').trim());
      const at = parts.findIndex(x => EMAIL.test(x));
      p = { email: at < 0 ? '' : emailKey(parts[at]), firstName: at > 0 ? parts[0] : '', lastName: at > 1 ? parts.slice(1, at).join(' ') : '',
        phone: parts[at + 1] || '', accreditation: parts[at + 2] || '', dob: '', address: '', accreditationProvider: '',
        membership: '', memberSince: '' };
    }
    if (!p.email || !EMAIL.test(p.email)) { if (row.some(c => (c || '').trim())) bad.push(row.join(', ')); continue; }
    if (seen.has(p.email)) continue;                      // the same person twice in one file: the first row wins
    seen.add(p.email);
    const had = byEmail.get(p.email) || null;
    if (!had && !p.firstName) { bad.push(row.join(', ')); continue; }
    p.existing = had;
    p.name = had ? had.name : fullName(p.firstName, p.lastName);
    people.push(p);
  }
  return {
    error: people.length ? '' : (bad.length ? 'No one could be read. Each row needs an email address and a name.' : 'No one found in the list.'),
    people, bad,
    added: people.filter(p => !p.existing),
    updated: people.filter(p => p.existing),
    unknownTypes: [...new Set(people.filter(p => p.unknownType).map(p => p.membership))],
  };
}

// Write the plan. New people are added as members; people already on the list become members if they
// were not (a suspension stays) and get the association's part from the file. Returns counts.
export async function applyMembers(store, plan, { newPid, today }) {
  let added = 0, updated = 0;
  const now = new Date().toISOString();
  for (const p of plan.people) {
    const assoc = { approved: true, nonMember: false };
    if (p.membership) assoc.membership = p.membership;
    if (p.memberSince) assoc.memberSince = p.memberSince;
    if (p.existing) {
      const was = p.existing;
      await store.saveUmpire({ ...was, ...assoc, ...(was.suspended ? {} : { active: true }), rejected: false,     // a suspension stays
        memberSince: assoc.memberSince || was.memberSince || today, updatedAt: now });
      updated++;
    } else {
      await store.saveUmpire({ pid: newPid(), email: p.email, firstName: p.firstName, lastName: p.lastName, name: p.name,
        phone: p.phone, dob: p.dob, address: p.address, accreditation: p.accreditation, accreditationProvider: p.accreditationProvider,
        ...assoc, active: true, memberSince: assoc.memberSince || today, updatedAt: now });
      added++;
    }
  }
  return { added, updated };
}
