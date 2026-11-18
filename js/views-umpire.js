// Screens for umpires: sign-in, profile, availability, my appointments.

import { h, toast, busy, todayLocal, mapsLink, setChildren } from './ui.js';
import { recordWithdrawal } from './withdrawals.js';
import { PLAYER_UMPIRE_COMPS } from './player-umpire.js';
import { fmtDay, fmtRange, gradeShort, compareGrades, allocFor, publishedAllocFor, newPid, emailKey, upcomingDates, byMonth, availKey, compKeyOf, compLabel, nameParts, fullName, COMPS } from './logic.js';

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
  const provider = h('input', { value: existing?.accreditationProvider || '', placeholder: 'For example, Cricket NSW', list: 'acc-providers' });
  // Signing up asks only for what is needed (a name); everything else is added later from the profile.
  const btn = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save' : 'Continue');
  return h('form', { class: 'card narrow', onsubmit: busy(btn, async e => {
    e.preventDefault();
    const names = { firstName: first.value.trim(), lastName: last.value.trim(), name: fullName(first.value, last.value) };
    await store.saveUmpire(existing
      ? { ...names, pid: existing.pid, email: S.user.email, dob: dob.value, address: address.value.trim(), phone: phone.value.trim(),
          accreditation: accreditation.value.trim(), accreditationProvider: provider.value.trim(), active: existing.active, updatedAt: new Date().toISOString() }
      : { ...names, pid: newPid(), email: S.user.email, active: S.isAdmin, updatedAt: new Date().toISOString() });
    await refreshUser();
    toast('Details saved');
    go(existing ? '/profile' : S.isAdmin ? '/my' : '/');
  }) },
  h('h1', {}, existing ? 'Your details' : 'Welcome'),
  !existing && h('p', { class: 'muted' }, 'What is your name? You can add the rest later from your profile.'),
  h('div', { class: 'two-up' }, h('label', {}, 'First name', first), h('label', {}, 'Last name', last)),
  existing && [h('label', {}, 'Date of birth', dob),
  h('label', {}, 'Address', address),
  h('label', {}, 'Mobile', phone),
  h('div', { class: 'two-up' }, h('label', {}, 'Umpire accreditation number', accreditation), h('label', {}, 'Accreditation provider', provider)),
  h('datalist', { id: 'acc-providers' }, ['Cricket NSW', 'Cricket Australia', 'NSW Cricket Umpires & Scorers Association'].map(v => h('option', { value: v }))),
  h('p', { class: 'muted small' }, 'Your date of birth, address and mobile are only visible to your appointments officers.')],
  h('p', {}, btn, ' ', existing && h('a', { class: 'btn', href: '#/profile' }, 'Cancel')));
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
  if (!u.active) root.append(h('p', { class: 'notice warn' }, u.deactivated
    ? 'Your membership is not active at the moment. Contact the appointments officer if that is not right.'
    : 'Your account is waiting for approval by the appointments officer. You can already give your availability.'));

  // ---- what the umpire has already answered (needed by the appointments below as well)
  const existing = season ? await store.getAvailability(season.id, u.email) : null;
  // Two copies: what is saved, and what is on screen. Only the parts that are ticked are ever saved,
  // and "Unsaved changes" is worked out per part by comparing the two.
  const days = { ...((existing && existing.days) || {}) };
  let savedDays = { ...days };
  const keysOf = c => c.dates.map(d => availKey(c.comp, d));

  // How this member umpires: give their availability for the officer to allocate, choose games
  // themselves (player umpire), or both. Their chosen games are saved with their availability.
  const modes = { regular: true, player: !!(existing && (existing.picks || []).length), ...((existing && existing.modes) || {}) };
  // Player umpiring is switched on, and described, by the appointments officer in Settings.
  const pu = (store.org && store.org.playerUmpire) || {};
  const puOn = !!pu.enabled;
  modes.regular = true;                          // Full umpire is a heading; each competition is ticked on its own
  // Which competitions they give availability for. Before they have said, the ones they have
  // answered in, or all of them for someone new.
  const ALL_COMPS = COMPS.map(c => c.key);           // the association's groups, in its order
  if (!Array.isArray(modes.comps)) {
    const answered = ALL_COMPS.filter(k => Object.keys((existing && existing.days) || {}).some(x => x.startsWith(k + ':')));
    modes.comps = answered.length ? answered : [...ALL_COMPS];
  }
  let savedPicks = ((existing && existing.picks) || []).filter(p => PLAYER_UMPIRE_COMPS.includes(p.comp));
  let picks = savedPicks.map(p => ({ ...p, dates: [...p.dates] }));

  const keysFor = comp => [...new Set([...Object.keys(days), ...Object.keys(savedDays)].filter(x => x.startsWith(comp + ':')))];
  const regularChanged = () => modes.regular && modes.comps.some(k => keysFor(k).some(x => days[x] !== savedDays[x]));
  const pickSig = list => list.map(p => `${p.gameId}:${[...p.dates].sort().join('+')}`).sort().join('|');
  const picksChanged = () => puOn && modes.player && pickSig(picks) !== pickSig(savedPicks);
  // Appointments they turned down, with when: a turn-down stands until the officer publishes the round again.
  let declined = ((existing && existing.declined) || []).slice();
  const put = (d, p) => store.saveAvailability({
    ...(existing || {}),                          // keeps what the officer marked (edited) and anything else not ours
    declined,
    seasonId: season.id, email: u.email, name: u.name, days: d,
    modes: { ...modes, comps: [...modes.comps] }, picks: p, updatedAt: new Date().toISOString(),
  });

  // ---- appointments (only shown when there are some)
  const today = todayLocal();
  const mine = [];
  // Every published round that is not over yet (not just the latest few, which could miss the next game).
  for (const r of rounds.filter(r => r.published && (r.end || r.start || '') >= today)) {
    for (const g of await store.listGames(r.id)) {
      if (g.removed) continue;
      // Only what the officer has published: changes since then reach umpires when they publish again.
      for (const d of g.days) if (d.date >= today && publishedAllocFor(r, g, d.date).some(a => a && a.p === u.pid)) mine.push({ g, d, r });
    }
  }
  // Soonest first: by date, then start time, then grade.
  mine.sort((a, b) => a.d.date.localeCompare(b.d.date) || (a.d.time || '').localeCompare(b.d.time || '') || gradeShort(a.g.grade).localeCompare(gradeShort(b.g.grade), undefined, { numeric: true }));

  const apptList = h('ul', { class: 'plain' });
  let repaintAvailability = () => {};                  // set once the availability buttons exist
  let drawSummary = () => {};                          // set once the summary exists

  // Turning down an appointment is the same as saying "Not available" for that day: the slot is
  // freed and the appointments officer is told. Doing nothing means the umpire is standing.
  const rOf = g => (mine.find(m => m.g === g) || {}).r || {};
  async function decline(g, d, btn) {
    if (!season) { toast('The season dates are not set up yet. Please tell the appointments officer.', 'err'); return; }
    const key = availKey(compKeyOf(g), d.date);
    if (!confirm(`Tell the appointments officer you can't umpire ${gradeShort(g.grade)} on ${fmtDay(d.date)}?\n\nYou will be marked "Not available" for that day and taken off the game.`)) return;
    btn.disabled = true;
    const before = savedDays;
    const next = { ...savedDays, [key]: 'no' };
    // A game they chose as a player umpire is given back for that day too, so it leaves their
    // choices and the officer's board as well.
    declined = [...declined.filter(x => !(x.gameId === g.id && x.date === d.date)), { roundId: rOf(g).id, gameId: g.id, comp: compKeyOf(g), date: d.date, at: new Date().toISOString() }];
    const nextPicks = savedPicks.map(p => (p.gameId === g.id ? { ...p, dates: p.dates.filter(x => x !== d.date) } : p)).filter(p => p.dates.length);
    try {
      await put(next, nextPicks);
      savedDays = next;
      days[key] = 'no';
      if (nextPicks.length !== savedPicks.length || nextPicks.some((p, i) => p.dates.length !== savedPicks[i].dates.length)) {
        savedPicks = nextPicks;
        picks = picks.map(p => (p.gameId === g.id ? { ...p, dates: p.dates.filter(x => x !== d.date) } : p)).filter(p => p.dates.length);
        drawPlayer();
      }
      await recordWithdrawal(store, { umpire: u, before, after: next, also: [{ comp: compKeyOf(g), date: d.date }] });
      toast('The appointments officer has been told, and you are marked Not available for that day.', 'warn');
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      toast('Could not save that. Please try again.', 'err');
      return;
    }
    drawAppointments();
    repaintAvailability(key);
    drawStatus();
    drawSummary();
  }

  function drawAppointments() {
    setChildren(apptList, mine.map(({ g, d, r }) => {
      const link = mapsLink(g);
      // Turned down, and the officer has not published the round again since (if they have, and the
      // umpire is still on the game, the officer has put them back on it).
      const said = declined.find(x => x.gameId === g.id && x.date === d.date);
      const isDeclined = !!said && !((r.publishedAt || '') > said.at);
      const btn = h('button', { class: 'btn small', type: 'button' }, "I can't do this");
      btn.onclick = () => decline(g, d, btn);
      return h('li', { class: 'appt' + (isDeclined ? ' declined' : ''), 'data-date': d.date },
        h('div', { class: 'appt-date' }, h('strong', {}, fmtDay(d.date)), d.time && h('span', { class: 'muted' }, d.time),
          g.days.length > 1 && h('span', { class: 'chip' }, `Day ${d.day}`)),
        h('div', {}, h('span', { class: 'chip' }, compLabel(compKeyOf(g))), ' ', h('span', { class: 'chip grade' }, gradeShort(g.grade)), `${g.home.name} v ${g.away.name}`),
        h('div', { class: 'muted' }, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, g.ground || 'Ground TBC') : (g.ground || 'Ground TBC')),
        h('div', { class: 'appt-action' }, isDeclined
          ? h('span', { class: 'chip warn' }, "You said you can't do this")
          : btn));
    }));
  }

  // Games they have said they can't do are not listed any more (the officer decides, and publishes).
  const gaveBack = ({ g, d, r }) => { const x = declined.find(y => y.gameId === g.id && y.date === d.date); return !!x && !((r.publishedAt || '') > x.at); };
  for (let i = mine.length - 1; i >= 0; i--) if (gaveBack(mine[i])) mine.splice(i, 1);
  if (mine.length) {
    drawAppointments();
    root.append(h('section', { class: 'card' }, h('h2', {}, 'My appointments'),
      apptList));
  }

  // ---- how this member umpires
  // Layout: one card with the choices (Full umpire and its competitions, Player umpire), then the
  // date form, then the games chosen as a player umpire.
  const modeCard = h('section', { class: 'card' });
  const availCard = h('section', { class: 'card' });
  const playerCard = h('section', { class: 'card player-card' });
  const playerBody = playerCard;
  let drawStatus = () => {};

  const modeBox = (key, title, hint) => {
    const cb = h('input', { type: 'checkbox', checked: modes[key], 'aria-label': title });
    cb.onchange = () => {
      modes[key] = cb.checked;                   // shows or hides that part; only Save sends anything
      drawModes();
      drawStatus();
    };
    return h('div', { class: 'row-between mode-row' },
      h('label', { class: 'mode' }, cb, h('span', {}, h('strong', {}, title), hint && h('span', { class: 'muted' }, hint))),
      statusChips[key] || null);
  };

  // Player umpire: the games this member has chosen, and a way to choose more.
  let lists = null;                                   // each upcoming round's games, loaded when first needed
  const ui = { comp: '', round: '' };
  const pickFor = id => picks.find(p => p.gameId === id);
  const takenOn = (comp, date, gameId) => picks.find(p => p.comp === comp && p.gameId !== gameId && p.dates.includes(date));

  function choosePick(list, g, dates) {
    picks = picks.filter(p => p.gameId !== g.id);
    picks.push({ roundId: list.roundId, gameId: g.id, comp: list.comp, grade: g.grade, label: `${g.home.name} v ${g.away.name}`, ground: g.ground || '', dates });
    picks.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
    drawPlayer();
    drawStatus();
  }
  function release(p) {
    picks = picks.filter(x => x !== p);
    drawPlayer();
    drawStatus();
  }

  async function drawPlayer() {
    playerCard.hidden = !puOn || !modes.player;
    if (!puOn || !modes.player) { setChildren(playerBody); return; }
    if (!lists) {
      setChildren(playerBody, h('p', { class: 'muted' }, 'Loading the fixtures\u2026'));
      try { lists = (await store.listFixtureLists()).filter(l => PLAYER_UMPIRE_COMPS.includes(l.comp) && (l.end || '') >= today && (l.games || []).length).sort((a, b) => (a.start || '').localeCompare(b.start || '')); }
      catch (e) { console.error(e); lists = []; }
    }
    const order = COMPS.map(c => c.key);
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

    setChildren(playerBody,
      h('h2', {}, 'Games I want to umpire'),
      picks.length
        ? h('ul', { class: 'plain my-picks' }, picks.map(p => h('li', { class: 'row-between' },
          h('span', {}, h('strong', {}, p.dates.map(fmtDay).join(' + ')), ' ', h('span', { class: 'chip' }, compLabel(p.comp)), ' ', h('span', { class: 'chip grade' }, gradeShort(p.grade)), ` ${p.label}`),
          h('button', { class: 'link', type: 'button', onclick: () => release(p) }, 'Remove'))))
        : h('p', { class: 'muted' }, 'You have not chosen any games yet.'),
      lists.length
        ? h('div', { class: 'chooser' },
          h('h3', {}, compsHere.length === 1 ? `Choose a ${compLabel(compsHere[0])} game` : 'Choose a game'),
          h('div', { class: 'chooser-pick' }, compsHere.length > 1 && compSel, roundSel, gradeSel),
          list && h('ul', { class: 'plain pick-list' }, [...list.games].filter(g => !ui.grade || g.grade === ui.grade)
            .sort((a, b) => compareGrades(a.grade, b.grade) || a.home.name.localeCompare(b.home.name))
            .filter(g => g.days.some(d => d.date >= today)).map(gameRow)))
        : h('p', { class: 'muted' }, 'No fixtures are available to choose from yet.'));
  }

  const compBox = key => {
    const cb = h('input', { type: 'checkbox', checked: modes.comps.includes(key), 'aria-label': compLabel(key) });
    cb.onchange = () => {
      modes.comps = ALL_COMPS.filter(k => (k === key ? cb.checked : modes.comps.includes(k)));
      drawModes();
      drawStatus();
    };
    return h('div', { class: 'comp-row' },
      h('label', { class: 'comp-pick' + (cb.checked ? ' on' : '') }, cb, compLabel(key)),
      statusChips[key]);
  };

  function drawModes() {
    setChildren(modeCard,
      puOn ? h('h2', {}, 'How I will umpire') : h('h2', {}, 'Full umpire'),
      puOn && h('h3', { class: 'mode-head' }, 'Full umpire'),
      h('div', { class: 'comp-list' + (puOn ? '' : ' flush') }, ALL_COMPS.filter(k => compsOffered.includes(k)).map(compBox)),
      !modes.comps.some(k => compsOffered.includes(k)) && !(puOn && modes.player) && h('p', { class: 'notice warn' }, 'Tick at least one competition.'),
      puOn && modeBox('player', (pu.title || '').trim() || 'Player umpire', (pu.description || '').trim()));
    availCard.hidden = !modes.regular || !modes.comps.some(k => compsOffered.includes(k));
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
  const card = h('div', { class: 'avail-body' });
  // A status for each competition and for player umpiring, shown whether or not it is ticked.
  const statusChips = Object.fromEntries([...ALL_COMPS, 'player'].map(k => [k, h('span', { class: 'chip' })]));
  if (!season) {
    root.append(h('section', { class: 'card' }, h('h2', {}, 'Availability'), h('p', { class: 'muted' }, 'The season dates have not been set up yet. Please check back soon.')));
    return root;
  }
  const hint = h('span', { class: 'muted' });
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const savebar = h('div', { class: 'savebar' }, hint, h('span', { class: 'savebar-btns' }, cancelBtn, saveBtn));
  let savedModes = structuredClone(modes);
  const hasSubmitted = () => Object.keys(savedDays).some(x => compsOffered.includes(x.slice(0, x.indexOf(':')))) || savedPicks.length > 0;
  drawStatus = () => {
    const regDirty = regularChanged(), plDirty = picksChanged();
    // ticked = this part will be sent by Save; an untouched change in an unticked part says so
    const paintChip = (c, ticked, changed, has) => {
      c.className = 'chip ' + (changed ? 'warn' : has ? 'ok' : 'muted-chip');
      c.textContent = changed ? 'Unsaved changes' : has ? '\u2713 Submitted' : 'Not submitted';
    };
    for (const k of ALL_COMPS) {
      paintChip(statusChips[k], modes.regular && modes.comps.includes(k),
        keysFor(k).some(x => days[x] !== savedDays[x]), Object.keys(savedDays).some(x => x.startsWith(k + ':')));
    }
    paintChip(statusChips.player, modes.player, pickSig(picks) !== pickSig(savedPicks), savedPicks.length > 0);
    const left = comps.filter(c => modes.comps.includes(c.comp)).flatMap(keysOf).filter(d => !days[d]).length;
    const regularOn = modes.regular && modes.comps.some(k => compsOffered.includes(k));
    const playerOn = puOn && modes.player;
    savebar.hidden = !regularOn && !playerOn && !hasSubmitted();   // nothing chosen: nothing to save
    cancelBtn.hidden = !hasSubmitted();
    saveBtn.disabled = !regDirty && !plDirty;            // nothing ticked has changed since the last save
    const parts = [];
    if (regularOn) parts.push(left ? `${left} date${left > 1 ? 's' : ''} not answered yet` : 'All dates answered');
    if (puOn && modes.player) parts.push(`${picks.length} game${picks.length === 1 ? '' : 's'} chosen`);
    hint.textContent = parts.join(' \u00b7 ');
  };

  const buttons = {};
  const rowEl = {};
  const paint = key => {
    buttons[key].forEach(([v, b]) => { b.classList.toggle('on', days[key] === v); b.setAttribute('aria-pressed', String(days[key] === v)); });
    if (days[key] && rowEl[key]) rowEl[key].classList.remove('missing');
  };
  const choose = (key, v) => {
    if (days[key] === v) delete days[key]; else days[key] = v;
    paint(key); drawStatus();
  };
  repaintAvailability = key => { if (buttons[key]) { paint(key); drawStatus(); } };
  const optBtn = (key, v, label) => h('button', { type: 'button', class: `opt ${v}`, 'aria-pressed': String(days[key] === v), onclick: () => choose(key, v) }, label);

  // One section per competition: availability is separate for Senior, T20 and Junior,
  // even when the dates overlap.
  const sections = comps.map(c => {
    const markAll = h('button', { class: 'link', type: 'button', onclick: () => { keysOf(c).forEach(k => { days[k] = 'yes'; paint(k); }); drawStatus(); } }, 'Mark all available');
    const row = (date, label, key = availKey(c.comp, date)) => {
      const yes = optBtn(key, 'yes', 'Available'), no = optBtn(key, 'no', 'Not available');
      buttons[key] = [['yes', yes], ['no', no]];
      yes.classList.toggle('on', days[key] === 'yes'); no.classList.toggle('on', days[key] === 'no');
      return (rowEl[key] = h('div', { class: 'drow' }, h('span', { class: 'dlabel' }, label), h('div', { class: 'opts' }, yes, no)));
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

  const saveOnce = busy(saveBtn, async () => {
    if ((!regularChanged() && !picksChanged()) || savebar.hidden) return;
    // Every ticked competition is sent with Save, new or edited, so each one must have every date
    // answered, Available or Not available. Unticked competitions are neither sent nor checked.
    const sending = modes.comps.filter(k => compsOffered.includes(k));
    const blanks = sending.map(k => ({ k, keys: comps.filter(c => c.comp === k).flatMap(keysOf).filter(x => !days[x]) })).filter(b => b.keys.length);
    if (blanks.length) {
      Object.values(rowEl).forEach(el => el.classList.remove('missing'));
      blanks.forEach(b => b.keys.forEach(x => rowEl[x] && rowEl[x].classList.add('missing')));
      const first = rowEl[blanks[0].keys[0]];
      if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`Answer every date before saving: ${blanks.map(b => `${compLabel(b.k)} has ${b.keys.length} left`).join(', ')}.`, 'err');
      return;
    }
    const before = savedDays;
    // Answers for a competition that is not ticked (or with Full umpire unticked) stay as last saved,
    // and so do the chosen games when Player umpire is unticked.
    const next = { ...savedDays };
    if (modes.regular) for (const k of modes.comps) for (const x of keysFor(k)) { if (days[x]) next[x] = days[x]; else delete next[x]; }
    const nextPicks = puOn && modes.player ? picks.map(p => ({ ...p, dates: [...p.dates] })) : savedPicks;
    await put(next, nextPicks);
    savedDays = next;
    savedPicks = nextPicks;
    savedModes = structuredClone(modes);
    drawStatus();
    drawSummary();
    setEditing(false);
    // Pulling out of a game that is already published: free the slot and tell the appointments officer.
    const w = await recordWithdrawal(store, { umpire: u, before, after: next });
    if (mine.length) drawAppointments();
    if (w) toast(`Saved. You were down for ${w.games.length} game${w.games.length === 1 ? '' : 's'} on those dates \u2014 the appointments officer has been told.`, 'warn');
    else toast(puOn && modes.player && nextPicks.length ? 'Saved. The appointments officer will see the games you chose.' : 'Availability saved');
  });
  saveBtn.onclick = async () => { await saveOnce(); drawStatus(); };   // busy() re-enables the button; put it back to how it should be

  setChildren(availCard, h('h2', {}, 'Availability'), card);
  setChildren(card,
    availIntro,
    sections.length ? sections : h('p', { class: 'muted' }, 'No upcoming dates.'));
  // ---- once submitted, the form folds away into a short summary, leaving room for the appointments.
  // Edit availability opens it again; Cancel puts back what was saved.
  const puTitle = (pu.title || '').trim() || 'Player umpire';
  const summaryCard = h('section', { class: 'card my-summary' });
  const formWrap = h('div', { class: 'avail-form' }, modeCard, availCard, playerCard, savebar);
  function setEditing(on) {
    summaryCard.hidden = on;
    formWrap.hidden = !on;
    if (on && formWrap.scrollIntoView) formWrap.scrollIntoView({ block: 'start' });
  }
  drawSummary = () => {
    const items = ALL_COMPS.filter(k => compsOffered.includes(k)).map(k => {
      const keys = comps.filter(c => c.comp === k).flatMap(keysOf);
      const yes = keys.filter(x => savedDays[x] === 'yes').length, no = keys.filter(x => savedDays[x] === 'no').length;
      const sent = Object.keys(savedDays).some(x => x.startsWith(k + ':'));
      return h('li', { class: 'row-between' },
        h('span', {}, h('strong', {}, compLabel(k)), sent && h('span', { class: 'muted' }, ` \u00b7 ${yes} available \u00b7 ${no} not available`)),
        h('span', { class: 'chip ' + (sent ? 'ok' : 'muted-chip') }, sent ? '\u2713 Submitted' : 'Not submitted'));
    });
    const n = savedPicks.length;
    setChildren(summaryCard,
      h('div', { class: 'row-between' }, h('h2', {}, 'My availability'),
        h('button', { class: 'btn', type: 'button', onclick: () => setEditing(true) }, 'Edit availability')),
      h('ul', { class: 'plain summary-list' }, items,
        // Shown like the competitions, chosen games or not, so every part's status is in one place.
        puOn && h('li', {},
          h('div', { class: 'row-between' }, h('span', {}, h('strong', {}, puTitle), n > 0 && h('span', { class: 'muted' }, ` \u00b7 ${n} game${n === 1 ? '' : 's'} chosen`)),
            h('span', { class: 'chip ' + (n ? 'ok' : 'muted-chip') }, n ? '\u2713 Submitted' : 'Not submitted')),
          n > 0 && h('ul', { class: 'plain muted small' }, savedPicks.map(p => h('li', {}, `${p.dates.map(fmtDay).join(' & ')} \u00b7 ${gradeShort(p.grade)} \u00b7 ${p.label}`))))));
  };
  cancelBtn.onclick = () => {
    for (const k of Object.keys(days)) delete days[k];
    Object.assign(days, savedDays);
    Object.keys(buttons).forEach(paint);
    Object.values(rowEl).forEach(el => el.classList.remove('missing'));
    picks = savedPicks.map(p => ({ ...p, dates: [...p.dates] }));
    Object.assign(modes, structuredClone(savedModes));
    drawModes();
    drawStatus();
    setEditing(false);
  };

  drawModes();
  drawStatus();
  drawSummary();
  root.append(summaryCard, formWrap);
  setEditing(!hasSubmitted());
  return root;
}
