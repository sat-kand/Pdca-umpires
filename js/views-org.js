// Screens about associations: choosing one, creating one, and its settings.
// Every association has its own umpires, officers, fixtures and allocations.

import { h, toast, busy, copyText, setChildren } from './ui.js';
import { emailKey, COMPS, DEFAULT_GROUPS, guessGroup, suggestUmpires, suggestGroups, compareGrades, gradeShort } from './logic.js';
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

    return saveButton(h('form', { class: 'card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      const types = rows.filter(t => (t.name || '').trim()).map(t => ({ name: t.name.trim(), fee: t.fee === '' || t.fee == null ? 0 : Number(t.fee) }));
      if (types.some(t => Number.isNaN(t.fee))) { toast('A fee is not a number', 'err'); return; }
      const renewalDay = dayPick.value && monthPick.value ? `${monthPick.value}-${dayPick.value}` : '';
      if ((dayPick.value || monthPick.value) && !renewalDay) { toast('Choose both a day and a month for the renewal date', 'err'); return; }
      await store.saveOrg({ membership: { renewalDay, types }, updatedAt: new Date().toISOString() });
      saved.add('membership');
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
    saveBtn), saveBtn, 'membership');
  }

  // Player umpires: whether members may choose their own (Senior) games, and the line they see about it.
  function playerUmpireCard() {
    const org = store.org;
    const p = org.playerUmpire || {};
    const on = h('input', { type: 'checkbox', checked: !!p.enabled });
    const text = h('textarea', { rows: 2, placeholder: 'e.g. Pick any Senior round, grade or fixture you want to umpire.' }, p.description || '');
    const title = h('input', { value: p.title || '', placeholder: 'Player umpire', 'aria-label': 'Name for player umpiring' });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    return saveButton(h('form', { class: 'card', onsubmit: busy(saveBtn, async e => {
      e.preventDefault();
      saved.add('playerUmpire');
      await store.saveOrg({ playerUmpire: { ...p, enabled: on.checked, title: title.value.trim(), description: text.value.trim() }, updatedAt: new Date().toISOString() });
      await ctx.refreshUser();
      toast('Saved', 'ok');
      await draw();
    }) },
    h('h2', {}, 'Player umpires'),
    h('label', { class: 'inline' }, on, ' Let members choose their own Senior games to umpire'),
    h('p', { class: 'muted small' }, 'When this is off, members only see "Full umpire". Games already chosen stay where they are.'),
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
    const seen = new Map();
    for (const l of lists) for (const g of l.games || []) if (!seen.has(g.grade)) seen.set(g.grade, g.comp || '');
    for (const gr of Object.keys(org.gradeGroups || {})) if (!seen.has(gr)) seen.set(gr, '');
    let grades = [...seen.keys()];
    const ui = {
      groups: ((org.groups && org.groups.length) ? org.groups : DEFAULT_GROUPS).map(g => ({ ...g })),
      gradeGroups: { ...(org.gradeGroups || {}) },
      gradeUmpires: { ...(org.gradeUmpires || {}) },
    };
    const groupOf = gr => ui.gradeGroups[gr] && ui.groups.some(g => g.key === ui.gradeGroups[gr]) ? ui.gradeGroups[gr]
      : (ui.groups.some(g => g.key === guessGroup(seen.get(gr))) ? guessGroup(seen.get(gr)) : ui.groups[0].key);
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
        ui.groups.filter(g => !['senior', 'junior', 't20'].includes(g.key)));   // all groups are replaced, so Senior etc. take back their keys
      if (!sug.groups.length) return;
      ui.groups = sug.groups.map(g => ({ ...g }));
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
        h('ul', { class: 'plain group-list' }, ui.groups.map((g, i) => h('li', { class: 'row-gap' },
          h('input', { value: g.name, 'aria-label': `Group ${i + 1} name`, oninput: e => {
            g.name = e.target.value;                        // rename it in the grade drop-downs as you type
            box.querySelectorAll(`option[value="${g.key}"]`).forEach(o => { o.textContent = g.name || '(no name)'; });
          } }),
          h('span', { class: 'muted small' }, `${grades.filter(gr => groupOf(gr) === g.key).length} grades`),
          ui.groups.length > 1 && !used(g.key) && h('button', { class: 'link', type: 'button', onclick: () => { ui.groups.splice(i, 1); draw2(); } }, 'Remove')))),
        h('button', { class: 'btn small', type: 'button', onclick: () => { ui.groups.push({ key: 'g' + Date.now().toString(36), name: 'New group' }); draw2(); } }, 'Add group'),
        h('h3', {}, 'Grades'),
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
      const groups = ui.groups.map(g => ({ key: g.key, name: (g.name || '').trim() || 'Group' }));
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
    h('p', { class: 'muted' }, 'A group is a set of grades you allocate together, such as Seniors, Juniors or Friday Girls. Each has its own tile on Allocate, and members give their availability per group. Grades set to "None" never need umpires and are left off the board.'),
    box,
    h('p', { class: 'muted small' }, 'Moving a grade to another group moves its upcoming games there. Members\' availability is kept per group, so check it after moving grades.'),
    saveBtn), saveBtn, 'groups');
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
      saveButton(h('form', { class: 'card', onsubmit: busy(save, async e => {
        e.preventDefault();
        const playCricketId = playCricketIdFrom(pc.value);
        if (pc.value.trim() && !playCricketId) { toast('That does not look like a Play Cricket link.', 'err'); return; }
        const moved = playCricketId !== (store.org.playCricketId || '');
        await store.saveOrg({ name: name.value.trim(), playCricketId, notifyEmail: (notify.value || '').trim().toLowerCase(), updatedAt: new Date().toISOString() });
        if (moved) {
          // Another association's fixtures: load them the next time Allocate opens; their groups are
          // suggested then, and groups left with no grades are removed.
          const season = await store.getSeason();
          if (season) await store.saveSeason({ ...season, updatedAt: '1970-01-01T00:00:00.000Z' });
        }
        saved.add('assoc');
        await ctx.refreshUser(); ctx.redrawHeader();
        toast(moved ? 'Saved. Allocate will load the fixtures from the new link.' : 'Saved', 'ok');
        await draw();
      }) },
      h('h2', {}, 'Association'),
      h('label', {}, 'Name', name),
      h('label', {}, 'Its page on Play Cricket (link)', pc),
      h('p', { class: 'muted small' }, 'Fixtures are read from this page.'),
      h('label', {}, 'Send alerts to', notify),
      h('p', { class: 'muted small' }, 'Where to email when an umpire pulls out of a published game.'),
      save), save, 'assoc'),

      await groupsCard(),
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
