// Screens for umpires: sign-in, profile, availability, my appointments.

import { h, toast, busy, todayLocal, mapsLink, setChildren } from './ui.js';
import { recordWithdrawal } from './withdrawals.js';
import { PLAYER_UMPIRE_COMPS } from './player-umpire.js';
import { fmtDay, fmtRange, gradeShort, compareGrades, allocFor, newPid, emailKey, upcomingDates, byMonth, availKey, compKeyOf, compLabel, nameParts, fullName } from './logic.js';

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

  // ---- what the umpire has already answered (needed by the appointments below as well)
  const existing = season ? await store.getAvailability(season.id, u.email) : null;
  const days = { ...((existing && existing.days) || {}) };
  const keysOf = c => c.dates.map(d => availKey(c.comp, d));
  let saved = !!existing, dirty = false;
  const savedDays = {};                      // what has been saved during this visit, for spotting a withdrawal

  // How this member umpires: give their availability for the officer to allocate, choose games
  // themselves (player umpire), or both. Their chosen games are saved with their availability.
  const modes = { regular: true, player: !!(existing && (existing.picks || []).length), ...((existing && existing.modes) || {}) };
  // Which competitions they give availability for. Before they have said, the ones they have
  // answered in, or all of them for someone new.
  const ALL_COMPS = ['senior', 'junior', 't20'];
  if (!Array.isArray(modes.comps)) {
    const answered = ALL_COMPS.filter(k => Object.keys((existing && existing.days) || {}).some(x => x.startsWith(k + ':')));
    modes.comps = answered.length ? answered : [...ALL_COMPS];
  }
  let picks = ((existing && existing.picks) || []).filter(p => PLAYER_UMPIRE_COMPS.includes(p.comp));

  const saveAvailability = () => store.saveAvailability({
    seasonId: season.id, email: u.email, name: u.name, days,
    modes: { ...modes }, picks: modes.player ? picks : [], updatedAt: new Date().toISOString(),
  });

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

  const apptList = h('ul', { class: 'plain' });
  let repaintAvailability = () => {};                  // set once the availability buttons exist

  // Turning down an appointment is the same as saying "Not available" for that day: the slot is
  // freed and the appointments officer is told. Doing nothing means the umpire is standing.
  async function decline(g, d, btn) {
    if (!season) { toast('The season dates are not set up yet. Please tell the appointments officer.', 'err'); return; }
    const key = availKey(compKeyOf(g), d.date);
    if (!confirm(`Tell the appointments officer you can't umpire ${gradeShort(g.grade)} on ${fmtDay(d.date)}?\n\nYou will be marked "Not available" for that day and taken off the game.`)) return;
    btn.disabled = true;
    const before = { ...((existing && existing.days) || {}), ...savedDays, ...days };
    days[key] = 'no';
    try {
      await saveAvailability();
      Object.assign(savedDays, days);
      saved = true;
      await recordWithdrawal(store, { umpire: u, before, after: days });
      toast('The appointments officer has been told, and you are marked Not available for that day.', 'warn');
    } catch (e) {
      console.error(e);
      delete days[key];
      btn.disabled = false;
      toast('Could not save that. Please try again.', 'err');
      return;
    }
    drawAppointments();
    repaintAvailability(key);
  }

  function drawAppointments() {
    setChildren(apptList, mine.map(({ g, d }) => {
      const link = mapsLink(g);
      const declined = days[availKey(compKeyOf(g), d.date)] === 'no';
      const btn = h('button', { class: 'btn small', type: 'button' }, "I can't do this");
      btn.onclick = () => decline(g, d, btn);
      return h('li', { class: 'appt' + (declined ? ' declined' : '') },
        h('div', { class: 'appt-date' }, h('strong', {}, fmtDay(d.date)), d.time && h('span', { class: 'muted' }, d.time),
          g.days.length > 1 && h('span', { class: 'chip' }, `Day ${d.day}`)),
        h('div', {}, h('span', { class: 'chip' }, compLabel(compKeyOf(g))), ' ', h('span', { class: 'chip grade' }, gradeShort(g.grade)), `${g.home.name} v ${g.away.name}`),
        h('div', { class: 'muted' }, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, g.ground || 'Ground TBC') : (g.ground || 'Ground TBC')),
        h('div', { class: 'appt-action' }, declined
          ? h('span', { class: 'chip warn' }, "You said you can't do this")
          : btn));
    }));
  }

  if (mine.length) {
    drawAppointments();
    root.append(h('section', { class: 'card' }, h('h2', {}, 'My appointments'),
      apptList));
  }

  // ---- how this member umpires
  const modeCard = h('section', { class: 'card' });
  const playerCard = h('section', { class: 'card player-card' });
  let drawStatus = () => {};

  const modeBox = (key, title, hint) => {
    const cb = h('input', { type: 'checkbox', checked: modes[key], 'aria-label': title });
    cb.onchange = () => {
      if (key === 'player' && !cb.checked && picks.length
        && !confirm(`Give back the ${picks.length} game${picks.length === 1 ? '' : 's'} you chose? The appointments officer will be able to give them to someone else.`)) { cb.checked = true; return; }
      modes[key] = cb.checked;
      dirty = true;
      drawModes();
      drawStatus();
    };
    return h('label', { class: 'mode' }, cb, h('span', {}, h('strong', {}, title), h('span', { class: 'muted' }, hint)));
  };

  // Player umpire: the games this member has chosen, and a way to choose more.
  let lists = null;                                   // each upcoming round's games, loaded when first needed
  const ui = { comp: '', round: '' };
  const pickFor = id => picks.find(p => p.gameId === id);
  const takenOn = (comp, date, gameId) => picks.find(p => p.comp === comp && p.gameId !== gameId && p.dates.includes(date));

  function choosePick(list, g, dates) {
    const before = pickFor(g.id);
    if (before && !modes.regular) before.dates.forEach(d => { delete days[availKey(list.comp, d)]; });
    picks = picks.filter(p => p.gameId !== g.id);
    picks.push({ roundId: list.roundId, gameId: g.id, comp: list.comp, grade: g.grade, label: `${g.home.name} v ${g.away.name}`, ground: g.ground || '', dates });
    picks.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
    for (const d of dates) { const k = availKey(list.comp, d); days[k] = 'yes'; repaintAvailability(k); }   // choosing a game means available that day
    dirty = true;
    drawPlayer();
    drawStatus();
  }
  function release(p) {
    picks = picks.filter(x => x !== p);
    if (!modes.regular) p.dates.forEach(d => { delete days[availKey(p.comp, d)]; });
    dirty = true;
    drawPlayer();
    drawStatus();
  }

  async function drawPlayer() {
    if (!modes.player) { setChildren(playerCard); return; }
    if (!lists) {
      setChildren(playerCard, h('h2', {}, 'Games I want to umpire'), h('p', { class: 'muted' }, 'Loading the fixtures\u2026'));
      try { lists = (await store.listFixtureLists()).filter(l => PLAYER_UMPIRE_COMPS.includes(l.comp) && (l.end || '') >= today && (l.games || []).length).sort((a, b) => (a.start || '').localeCompare(b.start || '')); }
      catch (e) { console.error(e); lists = []; }
    }
    const order = ['senior', 'junior', 't20'];
    const compsHere = order.filter(k => lists.some(l => l.comp === k));
    if (!compsHere.includes(ui.comp)) ui.comp = compsHere[0] || '';
    const roundsHere = lists.filter(l => l.comp === ui.comp);
    if (!roundsHere.some(l => l.roundId === ui.round)) ui.round = (roundsHere[0] || {}).roundId || '';
    const list = roundsHere.find(l => l.roundId === ui.round);
    const gradesHere = list ? [...new Set(list.games.map(g => g.grade))].sort(compareGrades) : [];
    if (ui.grade && !gradesHere.includes(ui.grade)) ui.grade = '';
    const gradeSel = h('select', { 'aria-label': 'Grade', onchange: e => { ui.grade = e.target.value; drawPlayer(); } },
      h('option', { value: '' }, 'All grades'),
      gradesHere.map(gr => h('option', { value: gr, selected: gr === ui.grade }, gr)));

    const compSel = h('select', { 'aria-label': 'Competition', onchange: e => { ui.comp = e.target.value; ui.round = ''; drawPlayer(); } },
      compsHere.map(k => h('option', { value: k, selected: k === ui.comp }, compLabel(k))));
    const roundSel = h('select', { 'aria-label': 'Round', onchange: e => { ui.round = e.target.value; drawPlayer(); } },
      roundsHere.map(l => h('option', { value: l.roundId, selected: l.roundId === ui.round }, `${fmtRange(l.dates)}${l.title ? ` \u00b7 ${l.title}` : ''}`)));

    const gameRow = g => {
      const mine = pickFor(g.id);
      const future = g.days.filter(d => d.date >= today);
      const btn = (text, dates) => {
        const clash = dates.map(d => takenOn(list.comp, d, g.id)).find(Boolean);
        const on = mine && mine.dates.length === dates.length && dates.every(d => mine.dates.includes(d));
        return h('button', { type: 'button', class: 'opt yes' + (on ? ' on' : ''), disabled: !!clash || on,
          title: clash ? `You have already chosen ${gradeShort(clash.grade)} ${clash.label} that day` : '',
          onclick: () => choosePick(list, g, dates) }, text);
      };
      const choices = future.length > 1
        ? [...future.map(d => btn(`Day ${d.day}`, [d.date])), btn('Both days', future.map(d => d.date))]
        : future.length ? [btn(mine ? 'Chosen' : 'Choose', [future[0].date])] : [];
      return h('li', { class: 'pick-row' + (mine ? ' chosen' : '') },
        h('div', {}, h('span', { class: 'chip grade' }, gradeShort(g.grade)), ` ${g.home.name} v ${g.away.name}`),
        h('div', { class: 'muted' }, [g.ground, g.days[0].time, g.matchType].filter(Boolean).join(' \u00b7 ')),
        h('div', { class: 'opts' }, choices, mine && h('button', { class: 'link', type: 'button', onclick: () => release(mine) }, 'Remove')));
    };

    setChildren(playerCard,
      h('h2', {}, 'Games I want to umpire'),
      picks.length
        ? h('ul', { class: 'plain my-picks' }, picks.map(p => h('li', { class: 'row-between' },
          h('span', {}, h('strong', {}, p.dates.map(fmtDay).join(' + ')), ' ', h('span', { class: 'chip' }, compLabel(p.comp)), ' ', h('span', { class: 'chip grade' }, gradeShort(p.grade)), ` ${p.label}`),
          h('button', { class: 'link', type: 'button', onclick: () => release(p) }, 'Remove'))))
        : h('p', { class: 'muted' }, 'You have not chosen any games yet.'),
      lists.length
        ? h('div', { class: 'chooser' },
          h('h3', {}, 'Choose a Senior game'),
          h('div', { class: 'chooser-pick' }, compsHere.length > 1 && compSel, roundSel, gradeSel),
          list && h('ul', { class: 'plain pick-list' }, [...list.games].filter(g => !ui.grade || g.grade === ui.grade)
            .sort((a, b) => compareGrades(a.grade, b.grade) || a.home.name.localeCompare(b.home.name))
            .filter(g => g.days.some(d => d.date >= today)).map(gameRow)))
        : h('p', { class: 'muted' }, 'No fixtures are available to choose from yet.'));
  }

  const compBox = key => {
    const cb = h('input', { type: 'checkbox', checked: modes.comps.includes(key), 'aria-label': compLabel(key) });
    cb.onchange = () => {
      const had = Object.keys(days).filter(k => k.startsWith(key + ':')).length;
      if (!cb.checked && had && !confirm(`Your ${compLabel(key)} answers will be cleared when you save. Carry on?`)) { cb.checked = true; return; }
      modes.comps = ALL_COMPS.filter(k => (k === key ? cb.checked : modes.comps.includes(k)));
      dirty = true;
      drawModes();
      drawStatus();
    };
    return h('label', { class: 'comp-pick' + (cb.checked ? ' on' : '') }, cb, compLabel(key));
  };

  function drawModes() {
    setChildren(modeCard,
      h('div', { class: 'row-between' }, h('h2', {}, 'How I will umpire'), statusChip),
      modeBox('regular', 'Give my availability', 'The appointments officer gives me games on the days I am free.'),
      modes.regular && h('div', { class: 'comp-picks' }, h('span', { class: 'muted' }, 'For'), ALL_COMPS.filter(k => compsOffered.includes(k)).map(compBox)),
      modes.regular && !modes.comps.some(k => compsOffered.includes(k)) && h('p', { class: 'notice warn' }, 'Tick at least one competition.'),
      modeBox('player', 'Choose my own games (player umpire)', 'Pick any Senior round, grade or fixture you want to umpire.'),
      !modes.regular && !modes.player && h('p', { class: 'notice warn' }, 'Tick one or both to give your availability.'));
    card.hidden = !modes.regular || !modes.comps.some(k => compsOffered.includes(k));
    for (const [k, el] of Object.entries(sectionEl)) el.hidden = !modes.comps.includes(k);
    const n = modes.comps.filter(k => compsOffered.includes(k)).length;
    availIntro.textContent = 'Tap an answer for each date, then Save.' + (n > 1 ? ' Each competition is answered separately.' : '');
    drawPlayer();
  }

  // ---- availability
  const comps = season ? upcomingDates(season.calendar, today) : [];
  const compsOffered = comps.map(c => c.comp);
  const sectionEl = {};
  const availIntro = h('p', { class: 'muted' });
  const card = h('section', { class: 'card' });
  const statusChip = h('span', { class: 'chip' });
  if (!season) {
    card.append(h('h2', {}, 'Availability'), h('p', { class: 'muted' }, 'The season dates have not been set up yet. Please check back soon.'));
    root.append(card);
    return root;
  }
  const chip = statusChip;
  const hint = h('span', { class: 'muted' });
  drawStatus = () => {
    chip.className = 'chip ' + (dirty ? 'warn' : saved ? 'ok' : 'warn');
    chip.textContent = dirty ? 'Unsaved changes' : saved ? '✓ Submitted' : 'Not submitted';
    const left = comps.filter(c => modes.comps.includes(c.comp)).flatMap(keysOf).filter(d => !days[d]).length;
    const parts = [];
    if (modes.regular) parts.push(left ? `${left} date${left > 1 ? 's' : ''} not answered yet` : 'All dates answered');
    if (modes.player) parts.push(`${picks.length} game${picks.length === 1 ? '' : 's'} chosen`);
    hint.textContent = parts.join(' \u00b7 ');
  };

  const buttons = {};
  const paint = key => buttons[key].forEach(([v, b]) => { b.classList.toggle('on', days[key] === v); b.setAttribute('aria-pressed', String(days[key] === v)); });
  const choose = (key, v) => {
    if (days[key] === v) delete days[key]; else days[key] = v;
    dirty = true; paint(key); drawStatus();
  };
  repaintAvailability = key => { if (buttons[key]) { paint(key); drawStatus(); } };
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
    return (sectionEl[c.comp] = h('div', { class: 'comp-section' }, h('div', { class: 'row-between comp-head' }, h('h2', { class: 'comp-title' }, c.label), markAll), tiles));
  });

  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  saveBtn.onclick = busy(saveBtn, async () => {
    const before = { ...((existing && existing.days) || {}), ...savedDays };
    if (modes.regular) {
      const keep = new Set((modes.player ? picks : []).flatMap(p => p.dates.map(d => availKey(p.comp, d))));
      for (const k of Object.keys(days)) if (!modes.comps.includes(k.split(':')[0]) && !keep.has(k)) delete days[k];
    }
    await saveAvailability();
    Object.assign(savedDays, days);
    saved = true; dirty = false; drawStatus();
    // Pulling out of a game that is already published: free the slot and tell the appointments officer.
    const w = await recordWithdrawal(store, { umpire: u, before, after: days });
    if (mine.length) drawAppointments();
    if (w) toast(`Saved. You were down for ${w.games.length} game${w.games.length === 1 ? '' : 's'} on those dates \u2014 the appointments officer has been told.`, 'warn');
    else toast(modes.player && picks.length ? 'Saved. The appointments officer will see the games you chose.' : 'Availability saved');
  });

  setChildren(card,
    h('h2', {}, 'Availability'),
    availIntro,
    sections.length ? sections : h('p', { class: 'muted' }, 'No upcoming dates.'));
  drawModes();
  drawStatus();
  root.append(modeCard, playerCard, card, h('div', { class: 'savebar' }, hint, saveBtn));
  return root;
}
