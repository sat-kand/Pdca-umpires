// Screens for umpires: sign-in, profile, availability, my appointments.

import { h, toast, spinner, busy, todayLocal, mapsLink } from './ui.js';
import { fmtDay, fmtRange, gradeShort, allocFor, newPid, emailKey } from './logic.js';

export function viewLogin(ctx) {
  const { store } = ctx;
  const email = h('input', { type: 'email', required: true, placeholder: 'you@example.com', autocomplete: 'email', id: 'login-email' });
  const msg = h('div');
  const btn = h('button', { class: 'btn' + (store.signInGoogle ? '' : ' primary'), type: 'submit' }, store.mode === 'demo' ? 'Sign in (demo)' : 'Email me a sign-in link');
  const google = store.signInGoogle && h('button', { class: 'btn primary wide', type: 'button' }, 'Continue with Google');
  if (google) google.onclick = busy(google, async () => { await store.signInGoogle(); });
  const form = h('form', { class: 'card narrow', onsubmit: busy(btn, async e => {
    e.preventDefault();
    const r = await store.sendLink(emailKey(email.value));
    if (r.sent) msg.replaceChildren(h('p', { class: 'notice ok' }, `We've emailed a sign-in link to ${email.value}. Open it on this device to continue.`));
  }) },
  h('h1', {}, 'Sign in'),
  h('p', { class: 'muted' }, store.mode === 'demo'
    ? 'Demo mode: no email is sent. Type any address to continue. Use admin@demo.test for the appointments officer view, or umpire1@demo.test … umpire10@demo.test for sample umpires.'
    : 'Use the same email address the appointments officer has for you.'),
  google, google && h('p', { class: 'muted center' }, 'or get a link by email'),
  h('label', {}, 'Email address', email), btn, msg);
  return form;
}

export async function viewProfile(ctx) {
  const { store, S, go, refreshUser } = ctx;
  const existing = S.umpire;
  const name = h('input', { required: true, value: existing?.name || '', placeholder: 'e.g. J Smith' });
  const phone = h('input', { type: 'tel', value: existing?.phone || '', placeholder: 'Optional' });
  const clubs = h('input', { value: existing?.clubs || '', placeholder: 'e.g. Kings Langley' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  return h('form', { class: 'card narrow', onsubmit: busy(btn, async e => {
    e.preventDefault();
    await store.saveUmpire({
      pid: existing?.pid || newPid(), email: S.user.email, name: name.value.trim(), phone: phone.value.trim(),
      clubs: clubs.value.trim(), active: existing ? existing.active : S.isAdmin,
      updatedAt: new Date().toISOString(),
    });
    await refreshUser();
    toast('Details saved');
    go('/');
  }) },
  h('h1', {}, existing ? 'Your details' : 'Welcome — tell us who you are'),
  !existing && h('p', { class: 'muted' }, 'This is a one-off step. The appointments officer will approve your account before you can be allocated.'),
  h('label', {}, 'Name as it should appear on the allocation report', name),
  h('label', {}, 'Mobile (optional, only visible to appointments officers)', phone),
  h('label', {}, 'Club(s) you play for or are connected with', clubs,
    h('small', { class: 'muted' }, 'So you are not appointed to their games. Separate several with commas.')),
  btn);
}

export async function viewHome(ctx) {
  const { store, S } = ctx;
  const u = S.umpire;
  const root = h('div');
  if (!u) {
    root.append(h('div', { class: 'card' }, h('h1', {}, 'Appointments officer'),
      h('p', {}, 'Use the Rounds menu above to manage rounds and allocations. If you also umpire, add your own details so you can give availability:'),
      h('a', { class: 'btn', href: '#/profile' }, 'Add my umpire details')));
    return root;
  }
  if (!u.active) root.append(h('p', { class: 'notice warn' }, 'Your account is waiting for approval by the appointments officer. You can already submit availability.'));

  const rounds = await store.listRounds();
  const open = rounds.filter(r => r.availabilityOpen);
  const published = rounds.filter(r => r.published).slice(0, 4);

  // --- appointments
  const mine = [];
  for (const r of published) {
    for (const g of await store.listGames(r.id)) {
      if (g.removed) continue;
      for (const d of g.days) if (allocFor(g, d.date).some(a => a && a.p === u.pid)) mine.push({ r, g, d });
    }
  }
  const today = todayLocal();
  const upcoming = mine.filter(x => x.d.date >= today).sort((a, b) => a.d.date.localeCompare(b.d.date) || gradeShort(a.g.grade).localeCompare(gradeShort(b.g.grade), undefined, { numeric: true }));
  root.append(h('section', { class: 'card' }, h('h2', {}, 'My upcoming appointments'),
    upcoming.length ? h('ul', { class: 'plain' }, upcoming.map(({ r, g, d }) => {
      const link = mapsLink(g);
      return h('li', { class: 'appt' },
        h('div', { class: 'appt-date' }, h('strong', {}, fmtDay(d.date)), d.time && h('span', { class: 'muted' }, ' ' + d.time),
          g.days.length > 1 && h('span', { class: 'chip' }, `Day ${d.day} of ${g.days.length}`)),
        h('div', {}, h('span', { class: 'chip grade' }, gradeShort(g.grade)), ` ${g.home.name} v ${g.away.name}`),
        h('div', { class: 'muted' }, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, g.ground || 'Ground TBC') : (g.ground || 'Ground TBC'), ' · ', r.title));
    })) : h('p', { class: 'muted' }, 'Nothing allocated yet. Allocations appear here once the appointments officer publishes a round.')));

  // --- availability
  const rows = await Promise.all(open.map(async r => ({ r, a: await store.getAvailability(r.id, u.email) })));
  root.append(h('section', { class: 'card' }, h('h2', {}, 'Availability'),
    rows.length ? h('ul', { class: 'plain' }, rows.map(({ r, a }) => h('li', { class: 'row-between' },
      h('div', {}, h('strong', {}, r.title), h('div', { class: 'muted' }, fmtRange(r.dates))),
      h('div', {}, a ? h('span', { class: 'chip ok' }, 'Submitted') : h('span', { class: 'chip warn' }, 'Needed'),
        h('a', { class: 'btn', href: `#/availability/${r.id}` }, a ? 'Edit' : 'Give availability'))))) :
      h('p', { class: 'muted' }, 'No round is open for availability right now.')));
  return root;
}

export async function viewAvailability(ctx, rid) {
  const { store, S, go } = ctx;
  const [round, existing] = await Promise.all([store.getRound(rid), store.getAvailability(rid, S.user.email)]);
  if (!round) return h('p', { class: 'notice warn' }, 'Round not found.');
  const days = { ...(existing?.days || {}) };
  const locked = !round.availabilityOpen;
  const note = h('textarea', { rows: 2, placeholder: 'Anything the appointments officer should know (optional)' }, existing?.note || '');
  if (locked) note.disabled = true;

  const OPTIONS = [['yes', 'Available'], ['maybe', 'Maybe'], ['no', 'Not available']];
  const rowFor = date => {
    const name = 'd-' + date;
    return h('fieldset', { class: 'day', disabled: locked }, h('legend', {}, fmtDay(date)),
      h('div', { class: 'seg' }, OPTIONS.map(([v, label]) => h('label', { class: 'seg-opt ' + v },
        h('input', { type: 'radio', name, value: v, checked: days[date] === v, onchange: () => { days[date] = v; } }),
        h('span', {}, label)))));
  };
  const saveBtn = h('button', { class: 'btn primary', type: 'submit', disabled: locked }, 'Save availability');
  const setAll = v => () => {
    round.dates.forEach(d => { days[d] = v; });
    document.querySelectorAll(`.day input[value="${v}"]`).forEach(i => { i.checked = true; });
  };
  return h('form', { class: 'card narrow', onsubmit: busy(saveBtn, async e => {
    e.preventDefault();
    const missing = round.dates.filter(d => !days[d]);
    if (missing.length) { toast('Please answer for every day: ' + missing.map(fmtDay).join(', '), 'err'); return; }
    await store.saveAvailability({
      roundId: rid, email: S.user.email, name: S.umpire.name, days, note: note.value.trim(), updatedAt: new Date().toISOString(),
    });
    toast('Availability saved');
    go('/');
  }) },
  h('h1', {}, round.title),
  h('p', { class: 'muted' }, locked ? 'This round is no longer open for availability.' : 'Tell us which days you can umpire.'),
  !locked && h('p', {}, h('button', { class: 'btn small', type: 'button', onclick: setAll('yes') }, 'All available'), ' ',
    h('button', { class: 'btn small', type: 'button', onclick: setAll('no') }, 'None available')),
  round.dates.map(rowFor),
  h('label', {}, 'Note', note), !locked && saveBtn);
}
