// Joining an association: the list of associations on Third Umpire, the form that asks for the details an
// association wants, and the card on My availability for the ones a person has not joined yet.
//
// Signing up does not put anyone in an association. They choose one, give the details it asks for (anything
// already on their profile is filled in), and the request waits for its officers to approve it. An association
// can instead say membership is not needed to umpire: then they can give availability as soon as they ask.

import { h, toast, busy, routePath } from './ui.js';
import { membershipOf, joinSettings, joinFieldsFor, missingJoinDetails, nameParts, fullName, JOIN_STATUS_LABEL, JOIN_STATUS_CHIP } from './logic.js';

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
const statusOf = st => (st.officer && !st.u ? 'officer' : membershipOf(st.u));
const fmtWhen = iso => (iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// Where someone stands, in words: the same wording as the officer's Members table (Member, Waiting for approval, ...).
// Where membership is not needed to umpire, someone waiting can already give their availability, and it says so.
export function standingChip(st, org) {
  const s = st.u ? membershipOf(st.u) : null;          // an admin with no membership row of their own has none
  const early = s === 'applied' && !joinSettings(org).membershipRequired;
  // Someone who is both an admin and a member shows both tags.
  const tags = [st.officer && 'officer', s].filter(Boolean);
  return h('span', { class: 'standing' }, tags.map(t => h('span', { class: 'chip ' + JOIN_STATUS_CHIP[t] }, JOIN_STATUS_LABEL[t])),
    early && h('span', { class: 'muted small' }, ' You can give your availability now'));
}

// Take back a request that is still waiting, then redraw wherever the person is.
export function cancelButton(ctx, org) {
  const b = h('button', { class: 'link', type: 'button' }, 'Cancel request');
  b.onclick = busy(b, async () => {
    if (!confirm(`Cancel your request to join ${org.name}?`)) return;
    await ctx.store.cancelJoin(org.id, ctx.S.user.email);
    toast('Request cancelled', 'ok');
    await ctx.refreshUser();
    ctx.go(routePath());
  });
  return b;
}

export const joinBtn = org => h('a', { class: 'btn small primary', href: `/join/${encodeURIComponent(org.id)}`, 'aria-label': `Join ${org.name}` }, 'Join');

// ---------- the associations someone is in ----------
// One row each: the name, where they stand (Admin, Member, Waiting for approval...) and Cancel for a request still waiting.
// Shown on their profile. Null when they are in none.
export async function myAssociationsList(ctx) {
  const { store, S } = ctx;
  const [orgs, standings] = await Promise.all([store.listJoinableOrgs(), store.listStandings(S.user.email)]);
  const known = new Map([...(S.myOrgs || []), ...orgs].map(o => [o.id, o]));
  const mine = standings.map(st => ({ st, org: known.get(st.orgId) })).filter(x => x.org).sort((a, b) => byName(a.org, b.org));
  if (!mine.length) return null;
  const mineRow = ({ st, org }) => {
    const s = statusOf(st);
    return h('li', { class: 'org-row', 'data-org': org.id },
      h('div', { class: 'org-main' }, h('strong', { class: 'assoc-name' }, org.name), standingChip(st, org)),
      s === 'applied' && joinSettings(org).membershipRequired && h('div', { class: 'org-actions' }, cancelButton(ctx, org)));
  };
  return h('ul', { class: 'plain org-list' }, mine.map(mineRow));
}

// ---------- the list of associations to join ----------
// For someone who is in none yet: the first page after signing up. Everyone else finds what they can join on My availability.
export async function viewAssociations(ctx) {
  const { store, S } = ctx;
  const [orgs, standings] = await Promise.all([store.listJoinableOrgs(), store.listStandings(S.user.email)]);
  const toJoin = orgs.filter(o => !standings.some(x => x.orgId === o.id) && joinSettings(o).open).sort(byName);
  const joinRow = o => h('li', { class: 'org-row' }, h('strong', { class: 'assoc-name' }, o.name), joinBtn(o));
  return h('div', { class: 'narrow-page' },
    h('h1', {}, 'Join an association'),
    h('section', { class: 'card' },
      toJoin.length
        ? h('ul', { class: 'plain org-list' }, toJoin.map(joinRow))
        : h('p', { class: 'muted' }, 'No association has joined Third Umpire yet. If yours should be here, ask your association to get in touch.')));
}

// ---------- the join form ----------
export async function viewJoin(ctx, orgId) {
  const { store, S } = ctx;
  const back = h('a', { href: '/associations' }, 'See all associations');
  const org = await store.getOrg(orgId);
  if (!org || org.plan === 'suspended') return h('p', { class: 'notice warn' }, 'We could not find that association. ', back);
  const set = joinSettings(org);
  if (!set.open) return h('p', { class: 'notice warn' }, `${org.name} is not taking new umpires through Third Umpire right now. `, back);

  const profile = (await store.getProfile(S.user.email)) || {};
  const nm = nameParts(profile);
  const first = h('input', { required: true, value: nm.firstName || '', autocomplete: 'given-name' });
  const last = h('input', { required: true, value: nm.lastName || '', autocomplete: 'family-name' });
  const fields = joinFieldsFor(org);
  const inputs = fields.map(f => ({ f, el: h('input', {
    type: f.type, value: profile[f.key] || '', autocomplete: f.autocomplete || 'off', list: f.list, 'data-field': f.key,
    ...(f.level === 'required' ? { required: true } : { placeholder: 'Optional' }) }) }));

  const btn = h('button', { class: 'btn primary', type: 'submit' }, set.membershipRequired ? 'Request to join' : `Join ${org.name}`);
  const form = h('form', { class: 'card narrow join-form', onsubmit: busy(btn, async e => {
    e.preventDefault();
    const details = { email: S.user.email, firstName: first.value.trim(), lastName: last.value.trim() };
    details.name = fullName(details.firstName, details.lastName);
    for (const { f, el } of inputs) details[f.key] = el.value.trim();
    const missing = missingJoinDetails(org, details);
    if (missing.length) { toast(`Please fill in: ${missing.join(', ')}`, 'err'); return; }
    await store.joinOrg(orgId, details);
    toast(set.membershipRequired ? `Request sent to ${org.name}` : `You have joined ${org.name}`, 'ok');
    await ctx.chooseOrg(orgId);                      // lands on that association's page: waiting for approval, or straight to availability
  }) },
  h('h1', {}, `Join ${org.name}`),
  h('p', { class: 'muted' }, set.membershipRequired
    ? 'Send your details to the association. The association will approve your request.'
    : 'Send your details to the association. You can give your availability straight away.'),
  h('div', { class: 'two-up' }, h('label', {}, 'First name', first), h('label', {}, 'Last name', last)),
  inputs.map(({ f, el }) => h('label', {}, f.label + (f.level === 'optional' ? ' (optional)' : ''), el)),
  fields.some(f => f.list) && h('datalist', { id: 'acc-providers' }, ['Cricket NSW', 'Cricket Australia', 'NSW Cricket Umpires & Scorers Association'].map(v => h('option', { value: v }))),
  fields.some(f => ['dob', 'address', 'phone'].includes(f.key)) && h('p', { class: 'muted small' }, 'Your date of birth, address and mobile are only visible to the association.'),
  h('p', {}, btn, ' ', h('a', { class: 'btn', href: '/associations' }, 'Back')));
  return form;
}

// ---------- on My availability: the other associations ----------
// The ones waiting for approval, and the ones not joined yet. Nothing at all when there is nothing to show.
export async function otherAssociationsCard(ctx, skipId) {
  const { store, S } = ctx;
  const [orgs, standings] = await Promise.all([store.listJoinableOrgs(), store.listStandings(S.user.email)]);
  const have = new Set(standings.filter(x => x.u).map(x => x.orgId));       // admins who have not joined still get a Join button
  const toJoin = orgs.filter(o => !have.has(o.id) && o.id !== skipId && joinSettings(o).open).sort(byName);
  if (!toJoin.length) return null;
  return h('section', { class: 'card other-associations' }, h('h2', {}, 'Other associations'),
    h('ul', { class: 'plain org-list' },
      toJoin.map(o => h('li', { class: 'org-row', 'data-org': o.id }, h('strong', { class: 'assoc-name' }, o.name), joinBtn(o)))));
}

// The wait itself, shown in place of the availability form on a pending request.
export function pendingCard(ctx, u) {
  const { store } = ctx;
  const org = store.org;
  return h('section', { class: 'card pending-card' },
    h('div', { class: 'avail-head' }, h('h2', {}, org.name)),
    h('p', {}, ctx.S.isAdmin && h('span', { class: 'chip ' + JOIN_STATUS_CHIP.officer }, JOIN_STATUS_LABEL.officer), ' ', h('span', { class: 'chip warn' }, 'Waiting for approval')),
    h('p', {}, 'Your request to join was sent', u && u.createdAt ? ` on ${fmtWhen(u.createdAt)}` : '', '. The association has to approve it before you can give your availability. We will show your availability here as soon as they do.'),
    ctx.S.isAdmin && h('p', { class: 'muted small' }, 'You are an admin here, so you can approve yourself on the Members page.'),
    h('p', {}, cancelButton(ctx, org)));
}

