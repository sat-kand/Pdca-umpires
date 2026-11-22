// Joining an association: the list of associations on Third Umpire, the form that asks for the details an
// association wants, and the card on My availability for the ones a person has not joined yet.
//
// Signing up does not put anyone in an association. They choose one, give the details it asks for (anything
// already on their profile is filled in), and the request waits for its officers to approve it. An association
// can instead say membership is not needed to umpire: then they can give availability as soon as they ask.

import { h, toast, busy } from './ui.js';
import { membershipOf, joinSettings, joinFieldsFor, missingJoinDetails, nameParts, fullName, JOIN_STATUS_LABEL, JOIN_STATUS_CHIP } from './logic.js';

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
const statusOf = st => (st.officer ? 'officer' : membershipOf(st.u));
const fmtWhen = iso => (iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// Where someone stands, in words. Someone who has asked to join an association that does not need approval
// is already in, so it says so.
function standingChip(st, org) {
  const s = statusOf(st);
  const open = s === 'applied' && !joinSettings(org).membershipRequired;
  return h('span', { class: 'chip ' + (open ? 'ok' : JOIN_STATUS_CHIP[s]) }, open ? 'Joined' : JOIN_STATUS_LABEL[s]);
}

// Take back a request that is still waiting, then redraw wherever the person is.
function cancelButton(ctx, org) {
  const b = h('button', { class: 'link', type: 'button' }, 'Cancel request');
  b.onclick = busy(b, async () => {
    if (!confirm(`Cancel your request to join ${org.name}?`)) return;
    await ctx.store.cancelJoin(org.id, ctx.S.user.email);
    toast('Request cancelled', 'ok');
    await ctx.refreshUser();
    ctx.go(location.hash.slice(1) || '/');
  });
  return b;
}

const joinBtn = org => h('a', { class: 'btn small primary', href: `#/join/${encodeURIComponent(org.id)}`, 'aria-label': `Join ${org.name}` }, 'Join');

// ---------- the list of associations ----------
// Everyone sees it first after signing up. Someone already in some associations sees those, then the rest to join.
export async function viewAssociations(ctx) {
  const { store, S } = ctx;
  const [orgs, standings] = await Promise.all([store.listJoinableOrgs(), store.listStandings(S.user.email)]);
  const known = new Map([...(S.myOrgs || []), ...orgs].map(o => [o.id, o]));
  const mine = standings.map(st => ({ st, org: known.get(st.orgId) })).filter(x => x.org).sort((a, b) => byName(a.org, b.org));
  const have = new Set(standings.map(x => x.orgId));
  const toJoin = orgs.filter(o => !have.has(o.id) && joinSettings(o).open).sort(byName);

  const joinRow = o => h('li', { class: 'org-row' }, h('strong', { class: 'org-name' }, o.name), joinBtn(o));
  const mineRow = ({ st, org }) => {
    const s = statusOf(st);
    const here = S.org && S.org.id === org.id;
    return h('li', { class: 'org-row', 'data-org': org.id },
      h('div', { class: 'org-main' }, h('strong', { class: 'org-name' }, org.name), standingChip(st, org)),
      h('div', { class: 'org-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => ctx.chooseOrg(org.id) }, here ? 'Open now' : 'Open'),
        s === 'applied' && joinSettings(org).membershipRequired && cancelButton(ctx, org)));
  };

  return h('div', { class: 'narrow-page' },
    h('h1', {}, mine.length ? 'Associations' : 'Join an association'),
    !mine.length && h('p', { class: 'muted' }, 'Choose the association you umpire for. You will be asked for the details it needs, and its officers approve your request before you give your availability.'),
    mine.length > 0 && h('section', { class: 'card' }, h('h2', {}, 'Your associations'), h('ul', { class: 'plain org-list' }, mine.map(mineRow))),
    h('section', { class: 'card' },
      h('h2', {}, mine.length ? 'Join another association' : 'Associations on Third Umpire'),
      toJoin.length
        ? h('ul', { class: 'plain org-list' }, toJoin.map(joinRow))
        : h('p', { class: 'muted' }, mine.length ? 'There are no other associations to join yet.' : 'No association has joined Third Umpire yet. If yours should be here, ask your appointments officer to get in touch.')));
}

// ---------- the join form ----------
export async function viewJoin(ctx, orgId) {
  const { store, S } = ctx;
  const back = h('a', { href: '#/associations' }, 'See all associations');
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
  // Anything we already have is filled in; say so, so they know to check it rather than retype it.
  const filled = (nm.firstName || nm.lastName ? 1 : 0) + inputs.filter(x => x.el.value).length;

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
    ? 'Send your details to the association. Its officers will approve your request, and then you can give your availability.'
    : 'Send your details to the association. You can give your availability straight away.'),
  filled > 0 && h('p', { class: 'notice' }, 'We have filled in what we already have from your profile. Check it, then send.'),
  h('div', { class: 'two-up' }, h('label', {}, 'First name', first), h('label', {}, 'Last name', last)),
  inputs.map(({ f, el }) => h('label', {}, f.label + (f.level === 'optional' ? ' (optional)' : ''), el)),
  fields.some(f => f.list) && h('datalist', { id: 'acc-providers' }, ['Cricket NSW', 'Cricket Australia', 'NSW Cricket Umpires & Scorers Association'].map(v => h('option', { value: v }))),
  fields.some(f => ['dob', 'address', 'phone'].includes(f.key)) && h('p', { class: 'muted small' }, 'Your date of birth, address and mobile are only visible to the association’s appointments officers.'),
  h('p', {}, btn, ' ', h('a', { class: 'btn', href: '#/associations' }, 'Back')));
  return form;
}

// ---------- on My availability: the other associations ----------
// The ones waiting for approval, and the ones not joined yet. Nothing at all when there is nothing to show.
export async function otherAssociationsCard(ctx) {
  const { store, S } = ctx;
  const [orgs, standings] = await Promise.all([store.listJoinableOrgs(), store.listStandings(S.user.email)]);
  const have = new Set(standings.map(x => x.orgId));
  const here = S.org && S.org.id;
  const waiting = standings
    .filter(st => !st.officer && st.orgId !== here && membershipOf(st.u) === 'applied')
    .map(st => ({ st, org: orgs.find(o => o.id === st.orgId) })).filter(x => x.org && joinSettings(x.org).membershipRequired);
  const toJoin = orgs.filter(o => !have.has(o.id) && joinSettings(o).open).sort(byName);
  if (!waiting.length && !toJoin.length) return null;
  return h('section', { class: 'card other-associations' }, h('h2', {}, 'Other associations'),
    h('ul', { class: 'plain org-list' },
      waiting.map(({ st, org }) => h('li', { class: 'org-row', 'data-org': org.id },
        h('div', { class: 'org-main' }, h('strong', { class: 'org-name' }, org.name), standingChip(st, org)),
        h('div', { class: 'org-actions' }, cancelButton(ctx, org)))),
      toJoin.map(o => h('li', { class: 'org-row', 'data-org': o.id }, h('strong', { class: 'org-name' }, o.name), joinBtn(o)))));
}

// The wait itself, shown in place of the availability form on a pending request.
export function pendingCard(ctx, u) {
  const { store } = ctx;
  const org = store.org;
  return h('section', { class: 'card pending-card' },
    h('div', { class: 'avail-head' }, h('h2', {}, org.name)),
    h('p', {}, h('span', { class: 'chip warn' }, 'Waiting for approval')),
    h('p', {}, 'Your request to join was sent', u && u.createdAt ? ` on ${fmtWhen(u.createdAt)}` : '', '. An officer of the association has to approve it before you can give your availability. We will show your availability here as soon as they do.'),
    h('p', {}, cancelButton(ctx, org)));
}

