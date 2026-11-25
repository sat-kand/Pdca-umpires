// Screens about associations: choosing one, creating one, and its settings.
// Every association has its own umpires, officers, fixtures and allocations.

import { h, toast, busy, copyText, setChildren, todayLocal } from './ui.js';
import { syncFixtures } from './rounds.js';
import { playerUmpireAllowed } from './player-umpire.js';
import { emailKey, joinSettings, JOIN_FIELDS, JOIN_LEVELS, COMPS, DEFAULT_GROUPS, guessGroup, groupKeyOf, suggestGroupName, suggestUmpires, suggestGroups, compareGrades, gradeShort } from './logic.js';
import { applyOrg } from './org-setup.js';

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

// A PlayHQ page link or the bare id -> the organisation id.
export function playhqIdFrom(text) {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text || '');
  return m ? m[0].toLowerCase() : '';
}

// The id format for a new association, for whoever sets one up.
// 'Parramatta District Cricket Association' -> 'parramatta-district-cricket-association-x7k2'
export function orgIdFrom(name, rand = Math.random) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'association';
  return `${slug}-${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

export const joinLink = id => `${location.origin}/join/${id}`;


// Officers only: name, PlayHQ organisation, who the officers are, and the link umpires join with.
export async function viewOrgSettings(ctx, section) {
  const { store, S } = ctx;
  const wrap = h('div');
  const draw = async () => setChildren(wrap, await build());
  // Save buttons are greyed out until something changes, and read "Saved" after saving.
  const saved = new Set();
  const saveButton = (form, btn, key) => {
    const label = btn.textContent;
    btn.disabled = true;
    if (saved.has(key)) btn.textContent = 'Saved';
    const changed = () => { btn.disabled = false; btn.textContent = label; };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    form.addEventListener('click', e => { if (e.target.closest('button[type=button]')) changed(); });   // Add / Remove
    return form;
  };

  // Membership: when it falls due, and the types an association offers, each with its own fee.
  function membershipCard() {
    const org = store.org;
    const m = org.membership || {};
    const rows = [...(m.types || [])];
    if (!rows.length) rows.push({ name: '', fee: '' });
    const list = h('div', { class: 'type-rows' });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save membership');

    const drawRows = () => setChildren(list, rows.map((t, i) => h('div', { class: 'type-row' },
      (() => { const n = h('input', { value: t.name, placeholder: 'e.g. Ordinary member', 'aria-label': 'Membership type' }); n.oninput = () => { rows[i].name = n.value; }; return n; })(),
      (() => { const f = h('input', { type: 'number', min: '0', step: '0.01', value: t.fee === '' || t.fee == null ? '' : t.fee, placeholder: 'Fee', 'aria-label': 'Membership fee' }); f.oninput = () => { rows[i].fee = f.value; }; return f; })(),
      h('button', { class: 'link', type: 'button', onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ name: '', fee: '' }); drawRows(); } }, 'Remove'))));
    drawRows();

    return saveButton(h('form', { class: 'card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      const types = rows.filter(t => (t.name || '').trim()).map(t => ({ name: t.name.trim(), fee: t.fee === '' || t.fee == null ? 0 : Number(t.fee) }));
      if (types.some(t => Number.isNaN(t.fee))) { toast('A fee is not a number', 'err'); return; }
      // Renewal (and membership lapsing) is not built yet, so only the types are kept here.
      await store.saveOrg({ membership: { ...(org.membership || {}), types }, updatedAt: new Date().toISOString() });
      saved.add('membership');
      await ctx.refreshUser();
      toast('Membership saved', 'ok');
      await draw();
    }) },
    h('h2', {}, 'Membership'),
    h('p', { class: 'muted small' }, 'Membership types and their fees. Members are given one of these on the Members page.'),
    list,
    h('p', {}, h('button', { class: 'btn small', type: 'button', onclick: () => { rows.push({ name: '', fee: '' }); drawRows(); } }, 'Add type')),
    saveBtn), saveBtn, 'membership');
  }

  // New umpires: whether the association is listed for people who sign up, whether they must be approved
  // before giving availability, and which personal details they are asked for when they join.
  function joiningCard() {
    const org = store.org;
    const set = joinSettings(org);
    const listed = h('input', { type: 'checkbox', checked: set.open });
    const notRequired = h('input', { type: 'checkbox', checked: !set.membershipRequired });
    const levels = JOIN_FIELDS.map(f => [f, h('select', { 'aria-label': `${f.label} when joining`, 'data-field': f.key },
      JOIN_LEVELS.map(([v, label]) => h('option', { value: v, selected: set.fields[f.key] === v }, label)))]);
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    return saveButton(h('form', { class: 'card joining-card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      await store.saveOrg({ joining: { open: listed.checked, membershipRequired: !notRequired.checked,
        fields: Object.fromEntries(levels.map(([f, sel]) => [f.key, sel.value])) }, updatedAt: new Date().toISOString() });
      saved.add('joining');
      await ctx.refreshUser();
      toast('Saved', 'ok');
      await draw();
    }) },
    h('h2', {}, 'New umpires'),
    h('p', { class: 'muted small' }, 'Someone who signs up chooses an association from the list. They give the details you ask for below (anything already on their profile is filled in), and you approve them on the Members page.'),
    h('label', { class: 'inline' }, listed, ' Show this association in the list for new umpires'),
    h('p', { class: 'muted small' }, 'Untick to stop new requests. People already in are not affected.'),
    h('label', { class: 'inline' }, notRequired, ' Membership is not required to umpire'),
    h('p', { class: 'muted small' }, 'When ticked, umpires give their availability as soon as they join, and you can allocate them before you approve them. When not ticked, they wait for your approval first.'),
    h('h3', {}, 'Details to ask for'),
    h('p', { class: 'muted small' }, 'Name and email are always asked for.'),
    levels.map(([f, sel]) => h('div', { class: 'join-field-row' }, h('span', {}, f.label), sel)),
    saveBtn), saveBtn, 'joining');
  }

  // Player umpires: whether members may choose their own games, in which groups, and the line they see about it.
  function playerUmpireCard() {
    const org = store.org;
    if (!playerUmpireAllowed(org)) return null;           // switched on per association by the platform owner
    const p = org.playerUmpire || {};
    const on = h('input', { type: 'checkbox', checked: !!p.enabled });
    const text = h('textarea', { rows: 2, placeholder: 'e.g. Pick any round, grade or fixture you want to umpire.' }, p.description || '');
    const chosen = Array.isArray(p.groups) ? p.groups : [];             // none until the officer ticks some
    const groupBoxes = COMPS.map(c => [c.key, h('input', { type: 'checkbox', checked: chosen.includes(c.key) })]);
    const title = h('input', { value: p.title || '', placeholder: 'Player umpire', 'aria-label': 'Name for player umpiring' });
    const groupErr = h('p', { class: 'notice warn', hidden: true, role: 'alert' }, 'Choose at least one group, or switch player umpires off.');
    groupBoxes.forEach(([, bx]) => bx.addEventListener('change', () => { if (groupBoxes.some(([, x]) => x.checked)) groupErr.hidden = true; }));
    // Off clears and locks the groups; on lets them be ticked (at least one is needed to save).
    const syncBoxes = () => groupBoxes.forEach(([, bx]) => { if (!on.checked) bx.checked = false; bx.disabled = !on.checked; });
    on.addEventListener('change', () => { syncBoxes(); if (!on.checked) groupErr.hidden = true; });
    syncBoxes();
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    return saveButton(h('form', { class: 'card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      const groups = groupBoxes.filter(([, b]) => b.checked).map(([k]) => k);
      if (on.checked && !groups.length) {                 // switched on with nowhere to choose games: nothing for members to see
        groupErr.hidden = false; toast('Choose at least one group for player umpires', 'err');
        return;
      }
      groupErr.hidden = true;
      saved.add('playerUmpire');
      // Switched on, or given a group it did not have: new to members who already answered.
      const added = on.checked && groups.length && (!p.enabled || !(p.groups || []).length || groups.some(k => !(p.groups || []).includes(k)));
      await store.saveOrg({ playerUmpire: { ...p, enabled: on.checked, groups, title: title.value.trim(), description: text.value.trim(),
        ...(added ? { addedAt: new Date().toISOString() } : {}) }, updatedAt: new Date().toISOString() });
      await ctx.refreshUser();
      toast('Saved', 'ok');
      await draw();
    }) },
    h('h2', {}, 'Player umpires'),
    h('label', { class: 'inline' }, on, ' Let members choose their own games to umpire'),
    h('p', { class: 'muted small' }, 'In these groups:'),
    h('div', { class: 'row-gap' }, groupBoxes.map(([k, b]) => h('label', { class: 'inline' }, b, ' ', COMPS.find(c => c.key === k).label))),
    groupErr,
    h('p', { class: 'muted small' }, 'When this is off, members only give their availability. Games already chosen stay where they are.'),
    h('label', {}, 'What it is called (leave empty for "Player umpire")', title),
    h('label', {}, 'What members are told (leave empty to show nothing)', text),
    saveBtn), saveBtn, 'playerUmpire');
  }

  // Groups and grades: which grades are allocated together (Allocate tiles, availability, reports), and
  // how many umpires each grade needs. Suggested from the fixtures; the officer adjusts once.
  async function groupsCard() {
    const org = store.org;
    let lists = [];
    try { lists = store.listFixtureLists ? await store.listFixtureLists() : []; } catch (e) { console.error(e); }
    // The grades and competitions from the last fixture sync, as PlayHQ lists them. Before the first sync, from the games held.
    const seen = new Map(Object.entries(org.gradeComps || {}));
    if (!seen.size) {
      for (const l of lists) for (const g of l.games || []) if (!g.removed && !seen.has(g.grade)) seen.set(g.grade, g.comp || '');
      for (const gr of Object.keys(org.gradeGroups || {})) if (!seen.has(gr)) seen.set(gr, '');
    }
    let grades = [...seen.keys()];
    const ui = {
      groups: ((org.groups && org.groups.length) ? org.groups : DEFAULT_GROUPS).map(g => ({ ...g })),
      gradeGroups: { ...(org.gradeGroups || {}) },
      gradeUmpires: { ...(org.gradeUmpires || {}) },
    };
    const groupOf = gr => ui.gradeGroups[gr] && ui.groups.some(g => g.key === ui.gradeGroups[gr]) ? ui.gradeGroups[gr]
      : (ui.groups.find(g => g.key === groupKeyOf(suggestGroupName(seen.get(gr) || '', org.name || ''))) || ui.groups[0]).key;
    const umpOf = gr => (gr in ui.gradeUmpires ? ui.gradeUmpires[gr] : suggestUmpires(gr, seen.get(gr)));
    // Groups with no grades (left from another association's fixtures, say) are not kept.
    if (grades.length) ui.groups = ui.groups.filter(g => grades.some(gr => groupOf(gr) === g.key)).concat([]);
    if (!ui.groups.length) ui.groups = DEFAULT_GROUPS.map(g => ({ ...g }));
    // Grades in their group's order, then by competition, then oldest / highest grade first.
    const gi = k => ui.groups.findIndex(g => g.key === k);
    grades = grades.sort((a, b) => gi(groupOf(a)) - gi(groupOf(b)) || (seen.get(a) || '').localeCompare(seen.get(b) || '') || compareGrades(a, b));
    const box = h('div');
    // Groups named from the competitions themselves, each grade in its competition's group.
    const useSuggestions = () => {
      const sug = suggestGroups([...new Set(seen.values())].filter(Boolean), org.name || '',
        ui.groups);
      if (!sug.groups.length) return;
      const before = new Map(ui.groups.map(g => [g.key, g]));
      const now = new Date().toISOString();
      ui.groups = sug.groups.map(g => ({ ...g, ...(before.has(g.key) ? { ...(before.get(g.key).addedAt ? { addedAt: before.get(g.key).addedAt } : {}), ...(before.get(g.key).closed ? { closed: true } : {}) } : { addedAt: now }) }));
      ui.gradeGroups = Object.fromEntries(grades.map(gr => [gr, sug.compGroup[seen.get(gr)] || ui.groups[0].key]));
      ui.groups = ui.groups.filter(g => Object.values(ui.gradeGroups).includes(g.key));
      ui.gradeUmpires = {};
      grades.sort((a, b) => gi(groupOf(a)) - gi(groupOf(b)) || (seen.get(a) || '').localeCompare(seen.get(b) || '') || compareGrades(a, b));
      draw2();
      box.closest('form')?.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const draw2 = () => {
      const used = k => grades.some(gr => groupOf(gr) === k);
      setChildren(box,
        h('h3', {}, 'Groups'),
        h('ul', { class: 'plain group-list' }, ui.groups.map((g, i) => h('li', { class: 'group-row' },
          h('input', { value: g.name, 'aria-label': `Group ${i + 1} name`, oninput: e => {
            g.name = e.target.value;                        // rename it in the grade drop-downs as you type
            box.querySelectorAll(`option[value="${g.key}"]`).forEach(o => { o.textContent = g.name || '(no name)'; });
          } }),
          h('span', { class: 'muted small' }, `${grades.filter(gr => groupOf(gr) === g.key).length} grades`),
          h('label', { class: 'inline open-toggle', title: 'When off, members do not see this group on My availability' },
            h('input', { type: 'checkbox', 'aria-label': `${g.name || 'Group'} open for availability`, checked: !g.closed, onchange: e => { if (e.target.checked) delete g.closed; else g.closed = true; } }), ' Open for availability'),
          ui.groups.length > 1 && !used(g.key) && h('button', { class: 'link', type: 'button', onclick: () => { ui.groups.splice(i, 1); draw2(); } }, 'Remove')))),
        h('button', { class: 'btn small', type: 'button', onclick: () => { ui.groups.push({ key: 'g' + Date.now().toString(36), name: 'New group', addedAt: new Date().toISOString() }); draw2(); } }, 'Add group'),
        h('h3', {}, 'Grades'),
        store.playhq && h('p', { class: 'row-gap' },
          h('button', { class: 'btn small', type: 'button', onclick: async ev => {
            const b = ev.currentTarget; b.disabled = true; b.textContent = 'Updating from PlayHQ…';
            try { await syncFixtures(store, { today: todayLocal() }); toast('Grades updated from PlayHQ'); location.reload(); }
            catch (e) { console.error(e); b.disabled = false; b.textContent = 'Update from PlayHQ'; toast(`Could not update (${e.message || e})`, 'err'); }
          } }, 'Update from PlayHQ'),
          h('span', { class: 'muted small' }, ' Reloads the grades and competitions as PlayHQ lists them now.')),
        !grades.length ? h('p', { class: 'muted' }, 'Grades appear here once fixtures have been loaded on Allocate.')
          : h('div', { class: 'table-wrap' }, h('table', { class: 'board grades-table' },
            h('thead', {}, h('tr', {}, ['Grade', 'Competition', 'Group', 'Umpires'].map(c => h('th', {}, c)))),
            h('tbody', {}, grades.map(gr => h('tr', { class: umpOf(gr) === 0 ? 'inactive' : '' },
              h('td', {}, h('span', { class: 'chip grade' }, gradeShort(gr)), ' ', h('span', { class: 'muted small' }, gr)),
              h('td', { class: 'muted small' }, seen.get(gr) || ''),
              h('td', {}, h('select', { 'aria-label': `Group for ${gr}`, onchange: e => { ui.gradeGroups[gr] = e.target.value; draw2(); } },
                ui.groups.map(g => h('option', { value: g.key, selected: groupOf(gr) === g.key }, g.name || '(no name)')))),
              h('td', {}, h('select', { 'aria-label': `Umpires for ${gr}`, onchange: e => { ui.gradeUmpires[gr] = Number(e.target.value); draw2(); } },
                [0, 1, 2].map(n => h('option', { value: n, selected: umpOf(gr) === n }, n === 0 ? 'None' : String(n)))))))))),
        h('p', { class: 'row-gap' },
          h('button', { class: 'link', type: 'button', onclick: useSuggestions }, 'Use the suggestions')));
    };
    draw2();
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    return saveButton(h('form', { class: 'card groups-card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      const groups = ui.groups.map(g => ({ key: g.key, name: (g.name || '').trim() || 'Group', ...(g.addedAt ? { addedAt: g.addedAt } : {}), ...(g.closed ? { closed: true } : {}) }));
      const gradeGroups = Object.fromEntries(grades.map(gr => [gr, groupOf(gr)]));
      const gradeUmpires = Object.fromEntries(grades.map(gr => [gr, umpOf(gr)]));
      await store.saveOrg({ groups, gradeGroups, gradeUmpires, updatedAt: new Date().toISOString() });
      saved.add('groups');
      applyOrg(store.org);
      // Rebuild the weeks on the next visit to Allocate, with games in their new groups.
      const season = await store.getSeason();
      if (season) await store.saveSeason({ ...season, updatedAt: '1970-01-01T00:00:00.000Z' });
      toast('Saved. Allocate will regroup the fixtures next time it opens.', 'ok');
      await draw();
    }) },
    h('h2', {}, 'Groups and grades'),
    h('p', { class: 'muted' }, 'A group is a set of grades you allocate together, such as Seniors, Juniors or Friday Girls. Each has its own tile on Allocate, and members give their availability per group, and you choose which groups are open for it. Grades set to "None" never need umpires and are left off the board.'),
    box,
    h('p', { class: 'muted small' }, 'Moving a grade to another group moves its upcoming games there. Members\' availability is kept per group, so check it after moving grades.'),
    saveBtn), saveBtn, 'groups');
  }

  // Settings is split into sections. Desktop: the list on the left, one section on the right. Phone: the list
  // first; tapping a section opens it, with a way back. Each list item says what is set now.
  const SECTIONS = [
    { key: 'association', title: 'Association', icon: '🏏' },
    { key: 'admins', title: 'Admins', icon: '👤' },
    { key: 'groups', title: 'Groups and grades', icon: '🗂' },
    { key: 'membership', title: 'Membership', icon: '💳' },
    { key: 'new-umpires', title: 'New umpires', icon: '✉️' },
    { key: 'player-umpires', title: 'Player umpires', icon: '🙋' },
  ];

  async function build() {
    const org = store.org;
    const admins = (await store.listAdmins()).sort();
    const link = joinLink(org.id);
    const live = !!store.playhq;                                 // only the live store reads PlayHQ; demo mode has made-up fixtures
    const list = SECTIONS.filter(x => x.key !== 'player-umpires' || playerUmpireAllowed(org));
    const cur = list.find(x => x.key === section) || list[0];
    const types = membershipTypes(org), join = joinSettings(org), pu = org.playerUmpire || {};
    const nGroups = Array.isArray(org.groups) ? org.groups.length : 0;
    const summary = {
      association: org.name || '',
      admins: `${admins.length} admin${admins.length === 1 ? '' : 's'}`,
      groups: nGroups ? `${nGroups} group${nGroups === 1 ? '' : 's'}` : 'Grades and umpires needed',
      membership: types.length ? `${types.length} type${types.length === 1 ? '' : 's'}` : 'No types yet',
      'new-umpires': !join.open ? 'Closed to new umpires' : join.membershipRequired ? 'Open · you approve' : 'Open · no approval',
      'player-umpires': pu.enabled ? 'On' : 'Off',
    };

    const body = {
      association: () => {
        const name = h('input', { required: true, value: org.name || '' });
        const notify = h('input', { type: 'email', value: org.notifyEmail || '', placeholder: S.user.email });
        const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
        return saveButton(h('form', { class: 'card', onsubmit: busy(save, async e => {
          e.preventDefault();
          await store.saveOrg({ name: name.value.trim(), notifyEmail: (notify.value || '').trim().toLowerCase(), updatedAt: new Date().toISOString() });
          saved.add('assoc');
          await ctx.refreshUser(); ctx.redrawHeader();
          toast('Saved', 'ok');
          await draw();
        }) },
        h('h2', {}, 'Association'),
        h('label', {}, 'Name', name),
        h('p', { class: 'muted small' }, live ? (org.playhqOrgId ? 'Fixtures are read from PlayHQ. The PlayHQ link is set up by Third Umpire: contact us to change it.' : 'Your PlayHQ link has not been set up yet. Contact Third Umpire to connect your fixtures.') : 'Demo mode: the fixtures are made up. A live association reads its fixtures from PlayHQ.'),
        h('label', {}, 'Send alerts to', notify),
        h('p', { class: 'muted small' }, 'Where to email when an umpire pulls out of a published game.'),
        save), save, 'assoc');
      },
      admins: () => {
        const add = h('input', { type: 'email', placeholder: 'admin@example.com', 'aria-label': 'Email of the new admin' });
        const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Add admin');
        return h('div', { class: 'card' }, h('h2', {}, 'Admins'),
          h('p', { class: 'muted small' }, 'Admins can use every page of the association, including this one.'),
          h('ul', { class: 'plain officers' }, admins.map(e => h('li', { class: 'row-between' }, h('span', {}, e),
            e === S.user.email ? h('span', { class: 'muted' }, 'you')
              : h('button', { class: 'link', type: 'button', onclick: async () => { if (!confirm(`Remove ${e} as an admin?`)) return; await store.removeAdmin(e); await draw(); } }, 'Remove')))),
          h('form', { class: 'inline-form', onsubmit: busy(addBtn, async e => {
            e.preventDefault();
            const email = emailKey(add.value);
            if (!email) return;
            await store.addAdmin(email);
            toast(`${email} is now an admin. They sign in at ${location.host} with that email.`, 'ok');
            await draw();
          }) }, add, addBtn));
      },
      groups: () => groupsCard(),
      membership: () => membershipCard(),
      'new-umpires': () => [
        h('div', { class: 'card' }, h('h2', {}, 'Link for umpires'),
          h('p', { class: 'muted' }, 'Send this link to your umpires.'),
          h('p', {}, h('code', { class: 'join-link' }, link)),
          h('button', { class: 'btn', type: 'button', onclick: async () => { const ok = await copyText(link); toast(ok ? 'Link copied' : 'Could not copy', ok ? 'ok' : 'err'); } }, 'Copy link')),
        joiningCard()],
      'player-umpires': () => playerUmpireCard(),
    };

    const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
      h('ul', { class: 'plain' }, list.map(x => h('li', {},
        h('a', { href: `/admin/settings/${x.key}`, class: 'settings-link' + (x === cur ? ' active' : ''), 'aria-current': x === cur ? 'page' : null },
          h('span', { class: 'settings-icon', 'aria-hidden': 'true' }, x.icon),
          h('span', { class: 'settings-text' }, h('strong', {}, x.title), h('span', { class: 'muted small' }, summary[x.key])),
          h('span', { class: 'settings-chev', 'aria-hidden': 'true' }, '›'))))));
    const content = h('div', { class: 'settings-content', 'data-section': cur.key },
      h('a', { href: '/admin/settings', class: 'settings-back' }, '‹ Settings'),
      await body[cur.key]());
    return h('div', { class: 'settings-page' + (section ? ' has-section' : '') },
      h('h1', {}, 'Settings'),
      h('div', { class: 'settings-layout' }, nav, content));
  }
  await draw();
  return wrap;
}
