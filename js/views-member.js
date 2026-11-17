// A member's full profile, for the appointments officer.
//
// Everything here is from this association only (details, availability, appointments, pull-outs),
// except one card: memberships with other associations. That card shows only the membership itself
// (association, type, active or not, since when), never another association's availability or games.

import { h, toast, setChildren, busy, todayLocal } from './ui.js';
import { fmtDay, gradeShort, compLabel, compKeyOf, allocFor, publishedAllocFor, nameParts, COMPS } from './logic.js';
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

  // ---- availability this season, upcoming dates by competition
  const days = (avail && avail.days) || {};
  const byComp = new Map();
  for (const [k, v] of Object.entries(days)) {
    const [comp, date] = k.split(':');
    if (date < today) continue;
    if (!byComp.has(comp)) byComp.set(comp, []);
    byComp.get(comp).push({ date, v });
  }
  for (const l of byComp.values()) l.sort((a, b) => a.date.localeCompare(b.date));
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
    !u.active && h('p', { class: 'notice warn' }, 'Not active: waiting for approval in Members.'),

    h('div', { class: 'stats' },
      stat(String(gamesUmpired), gamesUmpired === 1 ? 'game umpired here' : 'games umpired here'),
      stat(String(upcoming.length), 'upcoming appointments'),
      stat(String(dropped), dropped === 1 ? 'pull-out' : 'pull-outs'),
      stat(rate === null ? '—' : pct(rate), 'fulfilment rate')),

    h('section', { class: 'card' }, h('h2', {}, 'Membership'),
      row('First name', n.firstName), row('Last name', n.lastName), row('Email', u.email), row('Mobile', u.phone),
      row('Date of birth', fmtLong(u.dob)), row('Address', u.address), row('Accreditation no.', u.accreditation),
      row('Membership type', u.membership ? `${u.membership}${fee ? ` · ${money(fee)}` : ''}` : ''),
      row('Status', u.active ? 'Active' : 'Waiting for approval'),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Member since'),
        h('span', {}, sinceInput, !u.memberSince && since ? h('span', { class: 'muted small' }, ` first game here ${fmtLong(since)}`) : null)),
      h('p', { class: 'muted small' }, 'Details are edited in ', h('a', { href: '#/admin/members' }, 'Members'), '.')),

    h('section', { class: 'card' }, h('h2', {}, 'Availability'),
      !season ? h('p', { class: 'muted' }, 'No season set up yet.')
        : !byComp.size && !picks.length ? h('p', { class: 'muted' }, 'Nothing given for the rest of this season yet.')
        : h('div', {},
          ORDER.map(k => COMPS.find(c => c.key === k)).filter(c => c && byComp.has(c.key)).map(c => {
            const l = byComp.get(c.key);
            const yes = l.filter(x => x.v === 'yes').length, no = l.filter(x => x.v === 'no').length;
            return h('div', { class: 'avail-line' },
              h('div', {}, h('strong', {}, c.label), h('span', { class: 'muted' }, ` · ${yes} available · ${no} not available`)),
              h('div', { class: 'date-chips' }, l.map(x => h('span', { class: 'chip ' + (x.v === 'yes' ? 'ok' : 'no') }, `${fmtDay(x.date)} ${x.v === 'yes' ? '✓' : '✗'}`))));
          }),
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
