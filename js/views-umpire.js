// Screens for umpires: sign-in, profile, availability, my appointments.

import { h, toast, busy, todayLocal, mapsLink, setChildren } from './ui.js';
import { fmtDay, gradeShort, allocFor, newPid, emailKey, upcomingCalendar, groupByComp, availKey, compKeyOf, compLabel } from './logic.js';

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
    go(S.isAdmin ? '/my' : '/');
  }) },
  h('h1', {}, existing ? 'Your details' : 'Welcome — tell us who you are'),
  !existing && h('p', { class: 'muted' }, 'This is a one-off step. The appointments officer will approve your account before you can be allocated.'),
  h('label', {}, 'Name as it should appear on the allocation report', name),
  h('label', {}, 'Mobile (optional, only visible to appointments officers)', phone),
  h('label', {}, 'Club(s) you play for or are connected with', clubs,
    h('small', { class: 'muted' }, 'So you are not appointed to their games. Separate several with commas.')),
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
  const comps = season ? groupByComp(upcomingCalendar(season.calendar, today)) : [];
  const card = h('section', { class: 'card' });
  if (!season) {
    card.append(h('h2', {}, 'Availability'), h('p', { class: 'muted' }, 'The season dates have not been set up yet. Please check back soon.'));
    root.append(card);
    return root;
  }
  const existing = await store.getAvailability(season.id, u.email);
  const days = { ...((existing && existing.days) || {}) };
  const keysOf = c => c.rounds.flatMap(g => g.rows.map(r => availKey(c.comp, r.date)));
  const shown = comps.flatMap(keysOf);
  let saved = !!existing, dirty = false;

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
    const tiles = c.rounds.map(g => h('div', { class: 'tile' }, h('h3', {}, g.label),
      g.rows.map(r => {
        const key = availKey(c.comp, r.date);
        const yes = optBtn(key, 'yes', 'Available'), no = optBtn(key, 'no', 'Not available');
        buttons[key] = [['yes', yes], ['no', no]];
        yes.classList.toggle('on', days[key] === 'yes'); no.classList.toggle('on', days[key] === 'no');
        return h('div', { class: 'drow' }, h('span', { class: 'dlabel' }, r.of > 1 ? `Day ${r.dayNo} · ${fmtDay(r.date)}` : fmtDay(r.date)), h('div', { class: 'opts' }, yes, no));
      })));
    return h('div', { class: 'comp-section' }, h('div', { class: 'row-between comp-head' }, h('h2', { class: 'comp-title' }, c.label), markAll), tiles);
  });

  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  saveBtn.onclick = busy(saveBtn, async () => {
    await store.saveAvailability({ seasonId: season.id, email: u.email, name: u.name, days, updatedAt: new Date().toISOString() });
    saved = true; dirty = false; drawStatus();
    toast('Availability saved');
  });

  setChildren(card,
    h('div', { class: 'row-between' }, h('h2', {}, 'Availability'), chip),
    h('p', { class: 'muted' }, 'Tap your answer for each day, then press Save. It applies to the whole season. Each competition has its own answers, so you can say yes to Senior and no to Junior on the same day.'),
    sections.length ? sections : h('p', { class: 'muted' }, 'No upcoming dates.'),
    sections.length > 0 && h('div', { class: 'savebar' }, hint, saveBtn));
  drawStatus();
  root.append(card);
  return root;
}
