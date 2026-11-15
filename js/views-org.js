// Screens about associations: choosing one, creating one, and its settings.
// Every association has its own umpires, officers, fixtures and allocations.

import { h, toast, busy, copyText, setChildren } from './ui.js';
import { emailKey } from './logic.js';

const TRIAL_DAYS = 30;

// A Play Cricket page link (or the bare id) -> the organisation id.
export function playCricketIdFrom(text) {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text || '');
  return m ? m[0].toLowerCase() : '';
}

// 'Parramatta District Cricket Association' -> 'parramatta-district-cricket-association-x7k2'
export function orgIdFrom(name, rand = Math.random) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'association';
  return `${slug}-${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

export const joinLink = id => `${location.origin}${location.pathname}#/join/${id}`;

export function planText(org, now = Date.now()) {
  if (!org) return '';
  if (org.plan === 'active') return 'Subscription active';
  if (org.plan === 'suspended') return 'Suspended';
  const left = org.trialEnds ? Math.ceil((Date.parse(org.trialEnds) - now) / 86400000) : null;
  return left === null ? 'Free trial' : left > 0 ? `Free trial: ${left} day${left === 1 ? '' : 's'} left` : 'Free trial ended';
}

// Signed in, but no association chosen: pick one, or start a new one.
export async function viewAssociations(ctx) {
  const { store, S } = ctx;
  const mine = await store.listMyOrgs(S.user.email);
  const name = h('input', { required: true, placeholder: 'e.g. Parramatta District Cricket Association', id: 'org-name' });
  const pc = h('input', { placeholder: 'https://play.cricket.com.au/club/…', id: 'org-pc' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create association');
  const form = h('form', { class: 'card narrow left', onsubmit: busy(btn, async e => {
    e.preventDefault();
    const playCricketId = playCricketIdFrom(pc.value);
    if (pc.value.trim() && !playCricketId) { toast('That does not look like a Play Cricket link. Copy the address of your association\'s page on play.cricket.com.au.', 'err'); return; }
    const org = { id: orgIdFrom(name.value), name: name.value.trim(), playCricketId, plan: 'trial',
      trialEnds: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(), createdAt: new Date().toISOString() };
    await store.createOrg(org, S.user.email);
    await ctx.chooseOrg(org.id);
    toast('Association created. You are its first appointments officer.', 'ok');
  }) },
  h('h2', {}, 'Start a new association'),
  h('p', { class: 'muted' }, `You become its appointments officer. Free for ${TRIAL_DAYS} days.`),
  h('label', {}, 'Association name', name),
  h('label', {}, 'Its page on Play Cricket (link)', pc),
  h('p', { class: 'muted small' }, 'Fixtures are read from this page. You can add it later in Settings.'),
  btn);

  return h('div', {},
    h('h1', {}, 'Your associations'),
    mine.length
      ? h('div', { class: 'cards' }, mine.map(o => h('button', { class: 'card comp-tile org-tile', type: 'button', onclick: () => ctx.chooseOrg(o.id) },
        h('h2', {}, o.name), h('span', { class: 'muted' }, S.org && S.org.id === o.id ? 'Open now' : 'Open'))))
      : h('p', { class: 'notice' }, 'You are not in an association yet. If you are an umpire, open the link your appointments officer sent you.'),
    form);
}

// Officers only: name, Play Cricket link, who the officers are, and the link umpires join with.
export async function viewOrgSettings(ctx) {
  const { store, S } = ctx;
  const wrap = h('div');
  const draw = async () => setChildren(wrap, await build());

  async function build() {
    const org = store.org;
    const admins = (await store.listAdmins()).sort();
    const link = joinLink(org.id);
    const name = h('input', { required: true, value: org.name || '' });
    const pc = h('input', { value: org.playCricketId ? `https://play.cricket.com.au/club/-/${org.playCricketId}` : '', placeholder: 'https://play.cricket.com.au/club/…' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const add = h('input', { type: 'email', placeholder: 'officer@example.com', 'aria-label': 'Email of the new officer' });
    const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Add officer');

    return [
      h('div', { class: 'row-between' }, h('h1', {}, 'Settings'), h('span', { class: 'chip ' + (org.plan === 'suspended' ? 'warn' : 'ok') }, planText(org))),
      h('form', { class: 'card', onsubmit: busy(save, async e => {
        e.preventDefault();
        const playCricketId = playCricketIdFrom(pc.value);
        if (pc.value.trim() && !playCricketId) { toast('That does not look like a Play Cricket link.', 'err'); return; }
        await store.saveOrg({ name: name.value.trim(), playCricketId, updatedAt: new Date().toISOString() });
        await ctx.refreshUser(); ctx.redrawHeader();
        toast('Saved', 'ok');
      }) },
      h('h2', {}, 'Association'),
      h('label', {}, 'Name', name),
      h('label', {}, 'Its page on Play Cricket (link)', pc),
      h('p', { class: 'muted small' }, 'Fixtures are read from this page.'),
      save),

      h('div', { class: 'card' }, h('h2', {}, 'Link for umpires'),
        h('p', { class: 'muted' }, 'Send this link to your umpires. They sign in, add their name, and wait for you to approve them on the Umpires page.'),
        h('p', {}, h('code', { class: 'join-link' }, link)),
        h('button', { class: 'btn', type: 'button', onclick: async () => { toast(await copyText(link) ? 'Link copied' : 'Could not copy', 'ok'); } }, 'Copy link')),

      h('div', { class: 'card' }, h('h2', {}, 'Appointments officers'),
        h('ul', { class: 'plain officers' }, admins.map(e => h('li', { class: 'row-between' }, h('span', {}, e),
          e === S.user.email ? h('span', { class: 'muted' }, 'you')
            : h('button', { class: 'link', type: 'button', onclick: async () => { if (!confirm(`Remove ${e} as an officer?`)) return; await store.removeAdmin(e); await draw(); } }, 'Remove')))),
        h('form', { class: 'inline-form', onsubmit: busy(addBtn, async e => {
          e.preventDefault();
          const email = emailKey(add.value);
          if (!email) return;
          await store.addAdmin(email);
          toast(`${email} is now an officer. Send them the link above to sign in.`, 'ok');
          await draw();
        }) }, add, addBtn)),
    ];
  }
  await draw();
  return wrap;
}
