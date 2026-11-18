// Screens about associations: choosing one, creating one, and its settings.
// Every association has its own umpires, officers, fixtures and allocations.

import { h, toast, busy, copyText, setChildren } from './ui.js';
import { emailKey } from './logic.js';

// Used when the tool's owner sets up an association; it then edits its own list in Settings.
export const DEFAULT_TYPES = [
  { name: 'Ordinary member', fee: 0 },
  { name: 'Junior member', fee: 0 },
  { name: 'Life member', fee: 0 },
];
export const membershipTypes = org => ((org && org.membership && org.membership.types) || []).filter(t => t.name);
export const feeFor = (org, type) => { const t = membershipTypes(org).find(x => x.name === type); return t ? t.fee : null; };
// Membership renews on the same day every year, so only a day and month are stored, as 'MM-DD'.
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const daysInMonth = m => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(Number(m) || 1) - 1];
export function renewalOf(org) {
  const m = (org && org.membership) || {};
  if (m.renewalDay) return m.renewalDay;
  return m.renewalDate ? m.renewalDate.slice(5, 10) : '';       // an older association stored a full date
}
export function renewalText(org) {
  const v = renewalOf(org);
  const [mm, dd] = v.split('-').map(Number);
  return mm && dd ? `${dd} ${MONTHS[mm - 1]} each year` : '';
}
export const money = v => (v || v === 0 ? `$${Number(v).toFixed(2).replace(/\.00$/, '')}` : '');

// A Play Cricket page link (or the bare id) -> the organisation id.
export function playCricketIdFrom(text) {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text || '');
  return m ? m[0].toLowerCase() : '';
}

// The id format for a new association, for whoever sets one up.
// 'Parramatta District Cricket Association' -> 'parramatta-district-cricket-association-x7k2'
export function orgIdFrom(name, rand = Math.random) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'association';
  return `${slug}-${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

export const joinLink = id => `${location.origin}${location.pathname}#/join/${id}`;


// The associations this person belongs to. Associations themselves are set up by the tool's owner.
export async function viewAssociations(ctx) {
  const { store, S } = ctx;
  const mine = await store.listMyOrgs(S.user.email);
  return h('div', {},
    h('h1', {}, 'Your associations'),
    mine.length
      ? h('div', { class: 'cards' }, mine.map(o => h('button', { class: 'card comp-tile org-tile', type: 'button', onclick: () => ctx.chooseOrg(o.id) },
        h('h2', {}, o.name), h('span', { class: 'muted' }, S.org && S.org.id === o.id ? 'Open now' : 'Open'))))
      : h('p', { class: 'notice' }, 'You are not in an association yet. Open the link your appointments officer sent you, and they will approve you.'));
}

// Officers only: name, Play Cricket link, who the officers are, and the link umpires join with.
export async function viewOrgSettings(ctx) {
  const { store, S } = ctx;
  const wrap = h('div');
  const draw = async () => setChildren(wrap, await build());

  // Membership: when it falls due, and the types an association offers, each with its own fee.
  function membershipCard() {
    const org = store.org;
    const m = org.membership || {};
    const rows = [...(m.types || [])];
    if (!rows.length) rows.push({ name: '', fee: '' });
    // Day and month only: membership falls due on the same day every year.
    const [curM, curD] = (renewalOf(org) || '').split('-');
    const dayPick = h('select', { 'aria-label': 'Renewal day' });
    const monthPick = h('select', { 'aria-label': 'Renewal month' },
      h('option', { value: '' }, 'Month'),
      MONTHS.map((name, i) => h('option', { value: String(i + 1).padStart(2, '0'), selected: String(i + 1).padStart(2, '0') === curM }, name)));
    const fillDays = () => {
      const keep = dayPick.value || curD || '';
      const max = monthPick.value ? daysInMonth(monthPick.value) : 31;
      setChildren(dayPick, h('option', { value: '' }, 'Day'),
        Array.from({ length: max }, (_, i) => { const v = String(i + 1).padStart(2, '0');
          return h('option', { value: v, selected: v === keep }, String(i + 1)); }));
    };
    fillDays();
    monthPick.onchange = fillDays;
    const list = h('div', { class: 'type-rows' });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save membership');

    const drawRows = () => setChildren(list, rows.map((t, i) => h('div', { class: 'type-row' },
      (() => { const n = h('input', { value: t.name, placeholder: 'e.g. Ordinary member', 'aria-label': 'Membership type' }); n.oninput = () => { rows[i].name = n.value; }; return n; })(),
      (() => { const f = h('input', { type: 'number', min: '0', step: '0.01', value: t.fee === '' || t.fee == null ? '' : t.fee, placeholder: 'Fee', 'aria-label': 'Membership fee' }); f.oninput = () => { rows[i].fee = f.value; }; return f; })(),
      h('button', { class: 'link', type: 'button', onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ name: '', fee: '' }); drawRows(); } }, 'Remove'))));
    drawRows();

    return h('form', { class: 'card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      const types = rows.filter(t => (t.name || '').trim()).map(t => ({ name: t.name.trim(), fee: t.fee === '' || t.fee == null ? 0 : Number(t.fee) }));
      if (types.some(t => Number.isNaN(t.fee))) { toast('A fee is not a number', 'err'); return; }
      const renewalDay = dayPick.value && monthPick.value ? `${monthPick.value}-${dayPick.value}` : '';
      if ((dayPick.value || monthPick.value) && !renewalDay) { toast('Choose both a day and a month for the renewal date', 'err'); return; }
      await store.saveOrg({ membership: { renewalDay, types }, updatedAt: new Date().toISOString() });
      await ctx.refreshUser();
      toast('Membership saved', 'ok');
      await draw();
    }) },
    h('h2', {}, 'Membership'),
    h('label', {}, 'Renewal date (the same day every year)', h('div', { class: 'daymonth' }, dayPick, monthPick)),
    h('p', { class: 'muted small' }, 'Members who have not renewed by this date each year lose their membership. Registration and payment are not built yet.'),
    h('p', { class: 'muted small' }, 'Membership types and their fees. Members are given one of these on the Members page.'),
    list,
    h('p', {}, h('button', { class: 'btn small', type: 'button', onclick: () => { rows.push({ name: '', fee: '' }); drawRows(); } }, 'Add type')),
    saveBtn);
  }

  // Player umpires: whether members may choose their own (Senior) games, and the line they see about it.
  function playerUmpireCard() {
    const org = store.org;
    const p = org.playerUmpire || {};
    const on = h('input', { type: 'checkbox', checked: !!p.enabled });
    const text = h('textarea', { rows: 2, placeholder: 'e.g. Pick any Senior round, grade or fixture you want to umpire.' }, p.description || '');
    const title = h('input', { value: p.title || '', placeholder: 'Player umpire', 'aria-label': 'Name for player umpiring' });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    return h('form', { class: 'card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      await store.saveOrg({ playerUmpire: { enabled: on.checked, title: title.value.trim(), description: text.value.trim() }, updatedAt: new Date().toISOString() });
      await ctx.refreshUser();
      toast('Saved', 'ok');
      await draw();
    }) },
    h('h2', {}, 'Player umpires'),
    h('label', { class: 'inline' }, on, ' Let members choose their own Senior games to umpire'),
    h('p', { class: 'muted small' }, 'When this is off, members only see "Full umpire". Games already chosen stay where they are.'),
    h('label', {}, 'What it is called (leave empty for "Player umpire")', title),
    h('label', {}, 'What members are told (leave empty to show nothing)', text),
    saveBtn);
  }

  async function build() {
    const org = store.org;
    const admins = (await store.listAdmins()).sort();
    const link = joinLink(org.id);
    const name = h('input', { required: true, value: org.name || '' });
    const pc = h('input', { value: org.playCricketId ? `https://play.cricket.com.au/club/-/${org.playCricketId}` : '', placeholder: 'https://play.cricket.com.au/club/…' });
    const notify = h('input', { type: 'email', value: org.notifyEmail || '', placeholder: S.user.email });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const add = h('input', { type: 'email', placeholder: 'officer@example.com', 'aria-label': 'Email of the new officer' });
    const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Add officer');

    return [
      h('h1', {}, 'Settings'),
      h('form', { class: 'card', onsubmit: busy(save, async e => {
        e.preventDefault();
        const playCricketId = playCricketIdFrom(pc.value);
        if (pc.value.trim() && !playCricketId) { toast('That does not look like a Play Cricket link.', 'err'); return; }
        await store.saveOrg({ name: name.value.trim(), playCricketId, notifyEmail: (notify.value || '').trim().toLowerCase(), updatedAt: new Date().toISOString() });
        await ctx.refreshUser(); ctx.redrawHeader();
        toast('Saved', 'ok');
      }) },
      h('h2', {}, 'Association'),
      h('label', {}, 'Name', name),
      h('label', {}, 'Its page on Play Cricket (link)', pc),
      h('p', { class: 'muted small' }, 'Fixtures are read from this page.'),
      h('label', {}, 'Send alerts to', notify),
      h('p', { class: 'muted small' }, 'Where to email when an umpire pulls out of a published game.'),
      save),

      membershipCard(),
      playerUmpireCard(),

      h('div', { class: 'card' }, h('h2', {}, 'Link for umpires'),
        h('p', { class: 'muted' }, 'Send this link to your umpires. They sign in, add their details, and wait for you to approve them on the Members page.'),
        h('p', {}, h('code', { class: 'join-link' }, link)),
        h('button', { class: 'btn', type: 'button', onclick: async () => { { const ok = await copyText(link); toast(ok ? 'Link copied' : 'Could not copy', ok ? 'ok' : 'err'); }; } }, 'Copy link')),

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
