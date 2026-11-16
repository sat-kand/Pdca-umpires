// Screens for umpires: sign-in, profile, availability, my appointments.

import { h, toast, busy, todayLocal, mapsLink, setChildren } from './ui.js';
import { recordWithdrawal } from './withdrawals.js';
import { fmtDay, gradeShort, allocFor, newPid, emailKey, upcomingDates, byMonth, availKey, compKeyOf, compLabel, nameParts, fullName } from './logic.js';

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
  const was = nameParts(existing || {});
  const first = h('input', { required: true, value: was.firstName, autocomplete: 'given-name' });
  const last = h('input', { required: true, value: was.lastName, autocomplete: 'family-name' });
  const dob = h('input', { type: 'date', value: existing?.dob || '' });
  const address = h('input', { value: existing?.address || '', placeholder: 'Optional', autocomplete: 'street-address' });
  const phone = h('input', { type: 'tel', value: existing?.phone || '', placeholder: 'Optional', autocomplete: 'tel' });
  const accreditation = h('input', { value: existing?.accreditation || '', placeholder: 'Optional' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  return h('form', { class: 'card narrow', onsubmit: busy(btn, async e => {
    e.preventDefault();
    await store.saveUmpire({
      pid: existing?.pid || newPid(), email: S.user.email,
      firstName: first.value.trim(), lastName: last.value.trim(), name: fullName(first.value, last.value),
      dob: dob.value, address: address.value.trim(), phone: phone.value.trim(), accreditation: accreditation.value.trim(),
      active: existing ? existing.active : S.isAdmin,
      updatedAt: new Date().toISOString(),
    });
    await refreshUser();
    toast('Details saved');
    go(S.isAdmin ? '/my' : '/');
  }) },
  h('h1', {}, existing ? 'Your details' : 'Welcome — tell us who you are'),
  !existing && h('p', { class: 'muted' }, 'This is a one-off step. The appointments officer will approve your account before you can be allocated.'),
  h('div', { class: 'two-up' }, h('label', {}, 'First name', first), h('label', {}, 'Last name', last)),
  h('label', {}, 'Date of birth', dob),
  h('label', {}, 'Address', address),
  h('label', {}, 'Mobile', phone),
  h('label', {}, 'Umpire accreditation number', accreditation),
  h('p', { class: 'muted small' }, 'Your date of birth, address and mobile are only visible to your appointments officers.'),
  btn);
}

// The umpire's one and only page: upcoming appointments (if any) and the
// season's availability, answered with two buttons per day and one Save.
export async function viewMy(ctx) {
  const { store, S } = ctx;
  const u = S.umpire;
  if (!u) {
    return h('div', { class: 'card narrow' }, h('h1', {}, 'Add your umpire details'),
      h('p', { class: 'muted' }, 'You are signed in as an appointments officer. To give your own availability, add your details first.'),
      h('a', { class: 'btn primary', href: '#/profile' }, 'Add my details'));
  }
  const [season, rounds] = await Promise.all([store.getSeason(), store.listRounds()]);
  const root = h('div', { class: 'narrow-page' });
  if (!u.active) root.append(h('p', { class: 'notice warn' }, 'Your account is waiting for approval by the appointments officer. You can already give your availability.'));

  // ---- appointments (only shown when there are some)
  const today = todayLocal();
  const mine = [];
  for (const r of rounds.filter(r => r.published).slice(0, 4)) {
    for (const g of await store.listGames(r.id)) {
      if (g.removed) continue;
      for (const d of g.days) if (d.date >= today && allocFor(g, d.date).some(a => a && a.p === u.pid)) mine.push({ g, d });
    }
  }
  mine.sort((a, b) => a.d.date.localeCompare(b.d.date) || gradeShort(a.g.grade).localeCompare(gradeShort(b.g.grade), undefined, { numeric: true }));
  if (mine.length) {
    root.append(h('section', { class: 'card' }, h('h2', {}, 'My appointments'),
      h('ul', { class: 'plain' }, mine.map(({ g, d }) => {
        const link = mapsLink(g);
        return h('li', { class: 'appt' },
          h('div', { class: 'appt-date' }, h('strong', {}, fmtDay(d.date)), d.time && h('span', { class: 'muted' }, d.time),
            g.days.length > 1 && h('span', { class: 'chip' }, `Day ${d.day}`)),
          h('div', {}, h('span', { class: 'chip' }, compLabel(compKeyOf(g))), ' ', h('span', { class: 'chip grade' }, gradeShort(g.grade)), `${g.home.name} v ${g.away.name}`),
          h('div', { class: 'muted' }, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, g.ground || 'Ground TBC') : (g.ground || 'Ground TBC')));
      }))));
  }

  // ---- availability
  const comps = season ? upcomingDates(season.calendar, today) : [];
  const card = h('section', { class: 'card' });
  if (!season) {
    card.append(h('h2', {}, 'Availability'), h('p', { class: 'muted' }, 'The season dates have not been set up yet. Please check back soon.'));
    root.append(card);
    return root;
  }
  const existing = await store.getAvailability(season.id, u.email);
  const days = { ...((existing && existing.days) || {}) };
  const keysOf = c => c.dates.map(d => availKey(c.comp, d));
  const shown = comps.flatMap(keysOf);
  let saved = !!existing, dirty = false;
  const savedDays = {};                      // what has been saved during this visit, for spotting a withdrawal

  const chip = h('span', { class: 'chip' });
  const hint = h('span', { class: 'muted' });
  const drawStatus = () => {
    chip.className = 'chip ' + (dirty ? 'warn' : saved ? 'ok' : 'warn');
    chip.textContent = dirty ? 'Unsaved changes' : saved ? '✓ Submitted' : 'Not submitted';
    const left = shown.filter(d => !days[d]).length;
    hint.textContent = left ? `${left} date${left > 1 ? 's' : ''} not answered yet` : 'All dates answered';
  };

  const buttons = {};
  const paint = key => buttons[key].forEach(([v, b]) => { b.classList.toggle('on', days[key] === v); b.setAttribute('aria-pressed', String(days[key] === v)); });
  const choose = (key, v) => {
    if (days[key] === v) delete days[key]; else days[key] = v;
    dirty = true; paint(key); drawStatus();
  };
  const optBtn = (key, v, label) => h('button', { type: 'button', class: `opt ${v}`, 'aria-pressed': String(days[key] === v), onclick: () => choose(key, v) }, label);

  // One section per competition: availability is separate for Senior, T20 and Junior,
  // even when the dates overlap.
  const sections = comps.map(c => {
    const markAll = h('button', { class: 'link', type: 'button', onclick: () => { keysOf(c).forEach(k => { days[k] = 'yes'; paint(k); }); dirty = true; drawStatus(); } }, 'Mark all available');
    const row = (date, label, key = availKey(c.comp, date)) => {
      const yes = optBtn(key, 'yes', 'Available'), no = optBtn(key, 'no', 'Not available');
      buttons[key] = [['yes', yes], ['no', no]];
      yes.classList.toggle('on', days[key] === 'yes'); no.classList.toggle('on', days[key] === 'no');
      return h('div', { class: 'drow' }, h('span', { class: 'dlabel' }, label), h('div', { class: 'opts' }, yes, no));
    };
    // Same-length competitions: Round 2 -> Day 1 / Day 2. Mixed lengths (Juniors): a plain list of
    // dates grouped by month, because the same Saturday can be Day 2 for one grade and a one-day
    // round for another.
    const tiles = c.mode === 'rounds'
      ? c.rounds.map(g => h('div', { class: 'tile' }, h('h3', {}, g.label),
          g.rows.map(r => row(r.date, r.of > 1 ? `Day ${r.dayNo} · ${fmtDay(r.date)}` : fmtDay(r.date)))))
      : byMonth(c.dates).map(m => h('div', { class: 'tile' }, h('h3', {}, m.month), m.dates.map(date => row(date, fmtDay(date)))));
    return h('div', { class: 'comp-section' }, h('div', { class: 'row-between comp-head' }, h('h2', { class: 'comp-title' }, c.label), markAll), tiles);
  });

  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  saveBtn.onclick = busy(saveBtn, async () => {
    const before = { ...((existing && existing.days) || {}), ...savedDays };
    await store.saveAvailability({ seasonId: season.id, email: u.email, name: u.name, days, updatedAt: new Date().toISOString() });
    Object.assign(savedDays, days);
    saved = true; dirty = false; drawStatus();
    // Pulling out of a game that is already published: free the slot and tell the appointments officer.
    const w = await recordWithdrawal(store, { umpire: u, before, after: days });
    if (w) toast(`Saved. You were down for ${w.games.length} game${w.games.length === 1 ? '' : 's'} on those dates \u2014 the appointments officer has been told.`, 'warn');
    else toast('Availability saved');
  });

  setChildren(card,
    h('div', { class: 'row-between' }, h('h2', {}, 'Availability'), chip),
    h('p', { class: 'muted' }, 'Tap an answer for each date, then Save. Senior, T20 and Junior are separate.'),
    sections.length ? sections : h('p', { class: 'muted' }, 'No upcoming dates.'),
    sections.length > 0 && h('div', { class: 'savebar' }, hint, saveBtn));
  drawStatus();
  root.append(card);
  return root;
}
