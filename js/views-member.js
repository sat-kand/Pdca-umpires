// A member's full profile, for the appointments officer.
//
// Everything here is from this association only (details, availability, appointments, pull-outs),
// except one card: memberships with other associations. That card shows only the membership itself
// (association, type, active or not, since when), never another association's availability or games.

import { h, toast, setChildren, busy, todayLocal } from './ui.js';
import { fmtDay, gradeShort, compLabel, compKeyOf, allocFor, publishedAllocFor, nameParts, COMPS, availKey } from './logic.js';
import { feeFor, money } from './views-org.js';

// What other associations may see of this membership. Written whenever an officer saves or opens a member.
export function membershipLink(org, u) {
  return {
    orgId: org.id, orgName: org.name || org.id, membership: u.membership || '', active: !!u.active,
    since: u.memberSince || '', updatedAt: new Date().toISOString(),
  };
}

const pct = x => `${Math.round(x * 100)}%`;
// A date with its year, for things that can be years ago: "1 Oct 2014".
const fmtLong = d => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const ORDER = ['senior', 'junior', 't20'];
const ymd = iso => (iso || '').slice(0, 10);

export async function viewMember(ctx, pid) {
  const { store } = ctx;
  const today = todayLocal();
  const umpires = await store.listUmpires();
  const u = umpires.find(x => x.pid === pid);
  if (!u) return h('p', { class: 'notice warn' }, 'Member not found. ', h('a', { href: '#/admin/members' }, 'Back to Members'));

  const season = await store.getSeason();
  const [avail, rounds, withdrawals] = await Promise.all([
    season ? store.getAvailability(season.id, u.email) : null,
    store.listRounds(),
    store.listWithdrawals ? store.listWithdrawals() : [],
  ]);

  // ---- appointments in this association: every round, every game day they are in
  const appts = [];
  for (const r of rounds) {
    const games = await store.listGames(r.id);
    for (const g of games) {
      if (g.removed) continue;
      for (const d of g.days) {
        const onBoard = allocFor(g, d.date).find(a => a && a.p === u.pid);
        const given = r.published && publishedAllocFor(r, g, d.date).find(a => a && a.p === u.pid);
        if (!onBoard && !given) continue;
        appts.push({ r, g, d, published: !!given, pu: !!((given || onBoard) || {}).pu });
      }
    }
  }
  appts.sort((a, b) => a.d.date.localeCompare(b.d.date));
  const upcoming = appts.filter(a => a.d.date >= today);
  const past = appts.filter(a => a.d.date < today && a.published);
  const gamesUmpired = new Set(past.map(a => a.g.id)).size;            // a two-day game counts once

  // ---- pull-outs and how reliably they keep published games
  const mine = withdrawals.filter(w => w.pid === u.pid || w.email === u.email);
  const pulls = mine.flatMap(w => (w.games || []).map(ref => ({ ...ref, at: w.createdAt, restored: !!ref.restored })))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const dropped = pulls.filter(p => !p.restored).length;
  const kept = appts.filter(a => a.published).length;
  const rate = kept + dropped ? kept / (kept + dropped) : null;

  // ---- membership: keep this association's line for others up to date, then read them all
  const since = u.memberSince || (past[0] && past[0].d.date) || '';
  let others = [];
  try {
    if (store.saveMembershipLink) await store.saveMembershipLink(u.email, membershipLink(store.org, u));
    others = store.listMemberships ? (await store.listMemberships(u.email)).filter(m => m.orgId !== store.org.id) : [];
  } catch (e) { console.error('memberships', e); }

  // ---- availability this season: every upcoming playing date by competition, from the season calendar
  let rec = avail || (season ? { seasonId: season.id || 'manual', email: u.email, name: u.name, days: {} } : null);
  const byComp = new Map();
  for (const e of (season && season.calendar) || []) {
    const comp = e.comp || 'senior';
    for (const date of e.dates || []) {
      if (date < today) continue;
      if (!byComp.has(comp)) byComp.set(comp, new Set());
      byComp.get(comp).add(date);
    }
  }
  for (const [k, set] of byComp) byComp.set(k, [...set].sort());
  const picks = ((avail && avail.picks) || []).filter(p => (p.dates || []).some(d => d >= today));

  // ---- layout
  const n = nameParts(u);
  const fee = feeFor(store.org, u.membership);
  const row = (label, value) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, label), h('span', {}, value || '—'));
  const sinceInput = h('input', { type: 'date', value: u.memberSince || '', 'aria-label': 'Member since', class: 'in-dob' });
  sinceInput.onchange = busy(sinceInput, async () => {
    u.memberSince = sinceInput.value;
    await store.saveUmpire({ ...u, updatedAt: new Date().toISOString() });
    if (store.saveMembershipLink) await store.saveMembershipLink(u.email, membershipLink(store.org, u));
    toast('Saved', 'ok');
  });

  // Clicking a date steps it on, exactly like the officer's Availability sheet, and is marked as theirs.
  const NEXT = { none: 'yes', yes: 'no', no: 'none' };
  const LABEL = { yes: 'Available', no: 'Not available', none: 'No answer' };
  function availLine(c) {
    const dates = byComp.get(c.key);
    const line = h('div', { class: 'avail-line' });
    const draw = () => {
      const v = d => (rec.days || {})[availKey(c.key, d)] || 'none';
      const yes = dates.filter(d => v(d) === 'yes').length, no = dates.filter(d => v(d) === 'no').length;
      setChildren(line,
        h('div', {}, h('strong', {}, c.label), h('span', { class: 'muted' }, ` · ${yes} available · ${no} not available · ${dates.length - yes - no} no answer`)),
        h('div', { class: 'date-chips' }, dates.map(d => {
          const st = v(d);
          const b = h('button', { type: 'button', class: 'chip date-btn ' + ({ yes: 'ok', no: 'no', none: 'muted-chip' })[st], 'data-date': d,
            title: `${fmtDay(d)}: ${LABEL[st]}${(rec.edited || {})[availKey(c.key, d)] ? ' (set by the officer)' : ''}. Click to change.` },
            `${fmtDay(d)} ${({ yes: '✓', no: '✗', none: '–' })[st]}`);
          b.onclick = async () => {
            b.disabled = true;
            const key = availKey(c.key, d), to = NEXT[st];
            const days = { ...(rec.days || {}) }, edited = { ...(rec.edited || {}), [key]: true };
            if (to === 'none') delete days[key]; else days[key] = to;
            const next = { ...rec, days, edited, updatedAt: new Date().toISOString() };
            try { await store.saveAvailability(next); rec = next; draw(); }
            catch (e) { console.error(e); toast(e.message || String(e), 'err'); b.disabled = false; }
          };
          return b;
        })));
    };
    draw();
    return line;
  }

  // Membership status: approve or turn down someone who has just registered; otherwise active or inactive.
  const statusBox = h('span', { class: 'status-box' });
  const saveStatus = async (patch, msg) => {
    Object.assign(u, patch);
    if (u.active && !u.memberSince) { u.memberSince = today; sinceInput.value = today; }
    await store.saveUmpire({ ...u, updatedAt: new Date().toISOString() });
    if (store.saveMembershipLink) store.saveMembershipLink(u.email, membershipLink(store.org, u)).catch(e => console.error(e));
    drawStatus();
    toast(msg, 'ok');
  };
  function drawStatus() {
    const btn = (label, cls, fn) => { const b = h('button', { type: 'button', class: `btn small ${cls}` }, label); b.onclick = busy(b, fn); return b; };
    const pending = !u.active && !u.deactivated;
    setChildren(statusBox,
      h('span', { class: 'chip ' + (u.active ? 'ok' : pending ? 'warn' : 'muted-chip') }, u.active ? 'Active' : pending ? 'Waiting for approval' : 'Inactive'), ' ',
      pending
        ? [btn('Approve', 'primary', () => saveStatus({ active: true, deactivated: false }, 'Approved')), ' ',
           btn('Reject', 'danger', async () => {
             if (!confirm(`Turn down ${u.name}? Their registration is removed.`)) return;
             await store.deleteUmpire(u.email);
             toast('Registration turned down', 'ok');
             location.hash = '#/admin/members';
           })]
        : u.active
          ? btn('Make inactive', '', () => saveStatus({ active: false, deactivated: true }, 'Now inactive'))
          : btn('Make active', 'primary', () => saveStatus({ active: true, deactivated: false }, 'Now active')));
  }
  drawStatus();

  const apptRow = a => h('li', { class: 'row-between' },
    h('span', {}, h('strong', {}, fmtDay(a.d.date)), ' ', h('span', { class: 'chip' }, compLabel(compKeyOf(a.g))), ' ',
      h('span', { class: 'chip grade' }, gradeShort(a.g.grade)), ` ${a.g.home.name} v ${a.g.away.name}`,
      a.g.days.length > 1 ? h('span', { class: 'muted' }, ` · Day ${a.d.day}`) : null),
    h('span', {}, a.pu && h('span', { class: 'chip pu' }, 'Player umpire'), ' ',
      a.d.date >= today && !a.published && h('span', { class: 'chip muted-chip' }, 'Not published yet'),
      h('a', { class: 'muted small', href: `#/admin/round/${a.r.id}` }, ' Open')));

  const stat = (big, label) => h('div', { class: 'stat' }, h('strong', {}, big), h('span', { class: 'muted' }, label));

  return h('div', { class: 'member-profile' },
    h('div', { class: 'row-between' },
      h('h1', {}, u.name || `${n.firstName} ${n.lastName}`),
      h('a', { class: 'btn', href: '#/admin/members' }, '← Members')),

    h('div', { class: 'stats' },
      stat(String(gamesUmpired), gamesUmpired === 1 ? 'game umpired here' : 'games umpired here'),
      stat(String(upcoming.length), 'upcoming appointments'),
      stat(String(dropped), dropped === 1 ? 'pull-out' : 'pull-outs'),
      stat(rate === null ? '—' : pct(rate), 'fulfilment rate')),

    h('section', { class: 'card' }, h('h2', {}, 'Membership'),
      row('First name', n.firstName), row('Last name', n.lastName), row('Email', u.email), row('Mobile', u.phone),
      row('Date of birth', fmtLong(u.dob)), row('Address', u.address), row('Accreditation no.', u.accreditation),
      row('Membership type', u.membership ? `${u.membership}${fee ? ` · ${money(fee)}` : ''}` : ''),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Status'), statusBox),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Member since'),
        h('span', {}, sinceInput, !u.memberSince && since ? h('span', { class: 'muted small' }, ` first game here ${fmtLong(since)}`) : null)),
      h('p', { class: 'muted small' }, 'Details are edited in ', h('a', { href: '#/admin/members' }, 'Members'), '.')),

    h('section', { class: 'card' }, h('h2', {}, 'Availability'),
      !season ? h('p', { class: 'muted' }, 'No season set up yet.')
        : !byComp.size && !picks.length ? h('p', { class: 'muted' }, 'No playing dates left this season.')
        : h('div', {},
          h('p', { class: 'muted small' }, 'Click a date to change it: Available → Not available → no answer. Changes you make are marked as set by the officer.'),
          ORDER.map(k => COMPS.find(c => c.key === k)).filter(c => c && byComp.has(c.key)).map(c => availLine(c)),
          picks.length > 0 && h('div', { class: 'avail-line' },
            h('div', {}, h('strong', {}, (store.org.playerUmpire && store.org.playerUmpire.title) || 'Player umpire'), h('span', { class: 'muted' }, ` · ${picks.length} game${picks.length === 1 ? '' : 's'} chosen`)),
            h('ul', { class: 'plain muted small' }, picks.map(p => h('li', {}, `${p.dates.map(fmtDay).join(' & ')} · ${gradeShort(p.grade)} · ${p.label}`)))))),

    h('section', { class: 'card' }, h('h2', {}, `Upcoming appointments (${upcoming.length})`),
      upcoming.length ? h('ul', { class: 'plain appt-list' }, upcoming.map(apptRow)) : h('p', { class: 'muted' }, 'None.')),

    h('section', { class: 'card' }, h('h2', {}, `Past appointments (${past.length})`),
      past.length ? h('ul', { class: 'plain appt-list' }, [...past].reverse().map(apptRow)) : h('p', { class: 'muted' }, 'None yet.')),

    h('section', { class: 'card' }, h('h2', {}, `Pull-outs (${pulls.length})`),
      h('p', { class: 'muted small' }, 'Published games they later said they could not do. Fulfilment rate is the share of their published games they kept.'),
      pulls.length ? h('ul', { class: 'plain appt-list' }, pulls.map(p => h('li', { class: 'row-between' },
        h('span', {}, h('strong', {}, fmtDay(p.date)), ` ${p.label || ''}`),
        h('span', { class: 'muted small' }, p.restored ? 'Taken back' : p.at ? `Pulled out ${fmtLong(ymd(p.at))}` : 'Pulled out'))))
        : h('p', { class: 'muted' }, 'None.')),

    h('section', { class: 'card' }, h('h2', {}, 'Other associations'),
      h('p', { class: 'muted small' }, 'Membership only. Their availability and appointments elsewhere are not shared.'),
      others.length ? h('ul', { class: 'plain appt-list' }, others.map(m => h('li', { class: 'row-between' },
        h('span', {}, h('strong', {}, m.orgName || m.orgId), m.membership ? h('span', { class: 'muted' }, ` · ${m.membership}`) : null,
          m.since ? h('span', { class: 'muted' }, ` · since ${fmtLong(m.since)}`) : null),
        h('span', { class: 'chip ' + (m.active ? 'ok' : 'muted-chip') }, m.active ? 'Active' : 'Past'))))
        : h('p', { class: 'muted' }, 'No other memberships on record.')));
}
