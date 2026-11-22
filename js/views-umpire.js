// Screens for umpires: sign-in, profile, availability, my appointments.

import { h, toast, busy, todayLocal, mapsLink, setChildren } from './ui.js';
import { recordWithdrawal } from './withdrawals.js';
import { PLAYER_UMPIRE_COMPS } from './player-umpire.js';
import { fmtDay, fmtRange, gradeShort, compareGrades, allocFor, publishedAllocFor, newPid, emailKey, upcomingDates, byMonth, availKey, compKeyOf, compLabel, nameParts, fullName, COMPS, groupNeedsUmpires, needsUmpires, membershipOf } from './logic.js';

export function viewLogin(ctx) {
  const { store, S } = ctx;
  let last = '';
  try { last = (S && S.linkProblem && localStorage.getItem('pdca-last-email')) || ''; } catch { /* no storage */ }
  const email = h('input', { type: 'email', required: true, placeholder: 'you@example.com', autocomplete: 'email', id: 'login-email', value: last });
  const msg = h('div');
  // A sign-in link that did not work: say why, and the way out is the form below (the address is filled in when we know it).
  const problem = S && S.linkProblem ? h('p', { class: 'notice warn', role: 'alert' }, S.linkProblem) : h('span');
  const btn = h('button', { class: 'btn' + (store.signInGoogle ? '' : ' primary'), type: 'submit' }, store.mode === 'demo' ? 'Sign in (demo)' : (last ? 'Email me a new link' : 'Email me a sign-in link'));
  const google = store.signInGoogle && h('button', { class: 'btn primary wide', type: 'button' }, 'Continue with Google');
  if (google) google.onclick = busy(google, async () => { await store.signInGoogle(); });
  const form = h('form', { class: 'card narrow', onsubmit: busy(btn, async e => {
    e.preventDefault();
    const r = await store.sendLink(emailKey(email.value));
    if (r.sent) { if (S) S.linkProblem = ''; problem.remove(); }
    if (r.sent) msg.replaceChildren(h('p', { class: 'notice ok' }, `We've emailed a sign-in link to ${email.value}. Open it on this device to continue.`));
  }) },
  h('h1', {}, 'Sign in'),
  problem,
  h('p', { class: 'muted' }, store.mode === 'demo'
    ? 'Demo mode: no email is sent. Type any address to continue. Use admin@demo.test for the appointments officer view, or umpire1@demo.test … umpire10@demo.test for sample umpires.'
    : 'Enter your email address and we will send you a link to sign in.'),
  h('label', {}, 'Email address', email), btn, msg,
  google && h('p', { class: 'muted center' }, 'or'), google);
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
  // Signing up asks only for what is needed (a name); the rest is added later from the profile.
  const btn = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save' : 'Apply');
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
  !existing && h('p', { class: 'muted' }, `Apply to join ${(store.org && store.org.name) || 'the association'}. You can add the rest of your details later from your profile.`),
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
  // Everyone who is (or is asking to be) a member gives availability; that is what makes them an
  // Active umpire. Suspended and rejected people are not asked.
  const status = membershipOf(u);
  if (status === 'suspended' || status === 'rejected') {
    root.append(h('section', { class: 'card' }, h('h2', {}, (store.org && store.org.name) || 'Membership'),
      h('p', {}, status === 'suspended' ? 'Your membership is suspended at the moment. Contact the association if that is not right.' : 'Your application was not approved. Contact the association if you have questions.')));
    root.append(...(await otherOrgCards(ctx, u.email, todayLocal())));
    return root;
  }
  if (status === 'applied') root.append(h('p', { class: 'notice warn' }, 'Your application is waiting for approval by the association. You can already give your availability.'));

  // ---- what the umpire has already answered (needed by the appointments below as well)
  const existing = season ? await store.getAvailability(season.id, u.email) : null;
  // Two copies: what is saved, and what is on screen. Only the parts that are ticked are ever saved,
  // and "Unsaved changes" is worked out per part by comparing the two.
  const days = { ...((existing && existing.days) || {}) };
  let savedDays = { ...days };
  const keysOf = c => c.dates.map(d => availKey(c.comp, d));

  // How this member umpires: give their availability for the officer to allocate, choose games
  // themselves (player umpire), or both. Their chosen games are saved with their availability.
  // Player umpiring is never ticked for them: only by their own choice (or games they already chose).
  const modes = { regular: true, player: !!(existing && (existing.picks || []).length), ...((existing && existing.modes) || {}) };
  // Player umpiring is switched on, and described, by the appointments officer in Settings.
  const pu = (store.org && store.org.playerUmpire) || {};
  const orgName = (store.org && store.org.name) || 'Availability';
  const puOn = !!pu.enabled && PLAYER_UMPIRE_COMPS.length > 0;    // on, with at least one group to choose from
  modes.regular = true;                          // Full umpire is a heading; each competition is ticked on its own
  // Which competitions they give availability for. Before they have said, the ones they have
  // answered in, or all of them for someone new.
  const ALL_COMPS = COMPS.map(c => c.key);           // the association's groups, in its order
  if (!Array.isArray(modes.comps)) {
    const answered = ALL_COMPS.filter(k => Object.keys((existing && existing.days) || {}).some(x => x.startsWith(k + ':')));
    modes.comps = answered.length ? answered : [...ALL_COMPS];
  }
  let savedPicks = ((existing && existing.picks) || []).filter(p => PLAYER_UMPIRE_COMPS.includes(p.comp));
  // A group the association added after this member last saved, which they have not answered yet.
  let lastSaved = existing;                     // seen as of their last save: a group added after it is new to them
  const isNewGroup = k => isNewFor(COMPS.find(c => c.key === k), lastSaved);
  // Player umpiring, switched on (or given another group) after they last saved, with no games chosen.
  const isNewPlayer = () => isNewFor({ key: '\u0000', addedAt: pu.addedAt }, lastSaved) && !savedPicks.length;
  let picks = savedPicks.map(p => ({ ...p, dates: [...p.dates] }));

  const keysFor = comp => [...new Set([...Object.keys(days), ...Object.keys(savedDays)].filter(x => x.startsWith(comp + ':')))];
  const pickSig = list => list.map(p => `${p.gameId}:${[...p.dates].sort().join('+')}`).sort().join('|');
  const picksChanged = () => puOn && pickSig(picks) !== pickSig(savedPicks);
  // Appointments they turned down, with when: a turn-down stands until the officer publishes the round again.
  let declined = ((existing && existing.declined) || []).slice();
  const put = (d, p) => store.saveAvailability({
    ...(existing || {}),                          // keeps what the officer marked (edited) and anything else not ours
    declined,
    seasonId: season.id, email: u.email, name: u.name, days: d,
    modes: { regular: true, player: p.length > 0, comps: ALL_COMPS.filter(k => Object.keys(d).some(x => x.startsWith(k + ':'))) }, picks: p, updatedAt: new Date().toISOString(),
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
      toast('You are marked Not available for that day.', 'warn');
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

  // One card per game: a two-day game's days sit together, each with its own "I can't do this".
  function drawAppointments() {
    const byGame = new Map();
    for (const a of mine) { if (!byGame.has(a.g.id)) byGame.set(a.g.id, []); byGame.get(a.g.id).push(a); }
    setChildren(apptList, [...byGame.values()].map(days => {
      const { g } = days[0];
      const link = mapsLink(g);
      return h('li', { class: 'appt-game' },
        h('div', {}, h('span', { class: 'chip' }, compLabel(compKeyOf(g))), ' ', h('span', { class: 'chip grade' }, gradeShort(g.grade)), `${g.home.name} v ${g.away.name}`),
        h('div', { class: 'muted' }, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, g.ground || 'Ground TBC') : (g.ground || 'Ground TBC')),
        h('div', { class: 'appt-days' }, days.map(({ d, r }) => {
          // Turned down, and the officer has not published the round again since (if they have, and the
          // umpire is still on the game, the officer has put them back on it).
          const said = declined.find(x => x.gameId === g.id && x.date === d.date);
          const isDeclined = !!said && !((r.publishedAt || '') > said.at);
          const btn = h('button', { class: 'btn small', type: 'button' }, "I can't do this");
          btn.onclick = () => decline(g, d, btn);
          return h('div', { class: 'appt row-between' + (isDeclined ? ' declined' : ''), 'data-date': d.date },
            h('div', { class: 'appt-date' }, h('strong', {}, fmtDay(d.date)), d.time && h('span', { class: 'muted' }, d.time),
              g.days.length > 1 && h('span', { class: 'chip' }, `Day ${d.day}`)),
            h('div', { class: 'appt-action' }, isDeclined ? h('span', { class: 'chip warn' }, "You said you can't do this") : btn));
        })));
    }));
  }

  // Games they have said they can't do are not listed any more (the officer decides, and publishes).
  let apptCard = null;
  const gaveBack = ({ g, d, r }) => { const x = declined.find(y => y.gameId === g.id && y.date === d.date); return !!x && !((r.publishedAt || '') > x.at); };
  for (let i = mine.length - 1; i >= 0; i--) if (gaveBack(mine[i])) mine.splice(i, 1);
  if (mine.length) {
    drawAppointments();
    root.append(apptCard = h('section', { class: 'card' }, h('h2', {}, 'My appointments'),
      apptList));
  }

  // ---- the cards: one for each group, and one for player umpiring. Each has its own status, Edit, Save and Cancel.
  const playerBody = h('div', { class: 'player-edit' });
  let playerEditing = false;
  let drawStatus = () => {};

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
    if (!puOn || !playerEditing) { setChildren(playerBody); return; }
    if (!lists) {
      setChildren(playerBody, h('p', { class: 'muted' }, 'Loading the fixtures\u2026'));
      try {
        lists = (await store.listFixtureLists()).map(l => ({ ...l, games: (l.games || []).filter(needsUmpires) }))   // no grades set to None
          .filter(l => PLAYER_UMPIRE_COMPS.includes(l.comp) && groupNeedsUmpires(l.comp) && (l.end || '') >= today && l.games.length).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      }
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


  // ---- availability: one card for each group, answered and saved on its own
  const comps = season ? upcomingDates(season.calendar, today).filter(c => groupNeedsUmpires(c.comp)) : [];   // not groups that need no umpires
  const compsOffered = comps.map(c => c.comp);
  // A status for each group and for player umpiring.
  const statusChips = Object.fromEntries([...ALL_COMPS, 'player'].map(k => [k, h('span', { class: 'chip' })]));
  if (!season) {
    root.append(h('section', { class: 'card' }, h('h2', {}, 'Availability'), h('p', { class: 'muted' }, 'The season dates have not been set up yet. Please check back soon.')));
    return root;
  }
  const paintChip = (c, changed, has, fresh = false) => {
    c.className = 'chip ' + (changed ? 'warn' : has ? 'ok' : fresh ? 'new' : 'muted-chip');
    c.textContent = changed ? 'Unsaved changes' : has ? '✓ Submitted' : fresh ? 'Newly Added' : 'Not submitted';
  };
  const buttons = {};
  const rowEl = {};
  const paint = key => {
    if (!buttons[key]) return;
    buttons[key].forEach(([v, b]) => { b.classList.toggle('on', days[key] === v); b.setAttribute('aria-pressed', String(days[key] === v)); });
    if (days[key] && rowEl[key]) rowEl[key].classList.remove('missing');
  };
  const choose = (key, v) => {
    if (days[key] === v) delete days[key]; else days[key] = v;
    paint(key); drawStatus();
  };
  repaintAvailability = key => { if (buttons[key]) { paint(key); drawStatus(); } };
  const optBtn = (key, v, label) => h('button', { type: 'button', class: `opt ${v}`, 'aria-pressed': String(days[key] === v), onclick: () => choose(key, v) }, label);
  const sentOf = k => Object.keys(savedDays).some(x => x.startsWith(k + ':'));
  const dirtyOf = k => keysFor(k).some(x => days[x] !== savedDays[x]);

  // One card per group: availability is separate for Senior, T20 and Junior, even when the dates overlap.
  // Answered groups fold into a short summary with Edit; a group not answered yet is open.
  const editing = {};
  const groupCards = comps.map(c => {
    const k = c.comp, keys = keysOf(c);
    const markAll = h('button', { class: 'link', type: 'button', onclick: () => { keys.forEach(x => { days[x] = 'yes'; paint(x); }); drawStatus(); } }, 'Mark all available');
    const row = (date, label, key = availKey(c.comp, date)) => {
      const yes = optBtn(key, 'yes', 'Available'), no = optBtn(key, 'no', 'Not available');
      buttons[key] = [['yes', yes], ['no', no]];
      yes.classList.toggle('on', days[key] === 'yes'); no.classList.toggle('on', days[key] === 'no');
      return (rowEl[key] = h('div', { class: 'drow' }, h('span', { class: 'dlabel' }, label), h('div', { class: 'opts' }, yes, no)));
    };
    // Same-length groups: Round 2 -> Day 1 / Day 2. Mixed lengths (Juniors): a plain list of dates grouped by month.
    const tiles = c.mode === 'rounds'
      ? c.rounds.map(g => h('div', { class: 'tile' }, h('h3', {}, g.label),
          g.rows.map(r => row(r.date, r.of > 1 ? `Day ${r.dayNo} · ${fmtDay(r.date)}` : fmtDay(r.date)))))
      : byMonth(c.dates).map(m => h('div', { class: 'tile' }, h('h3', {}, m.month), m.dates.map(date => row(date, fmtDay(date)))));
    const chip = statusChips[k];
    const summary = h('p', { class: 'muted group-summary' });
    const editBtn = h('button', { class: 'btn small', type: 'button' });
    const hint = h('span', { class: 'muted' });
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, `Save ${c.label}`);
    const body = h('div', { class: 'group-dates' }, h('div', { class: 'group-tools' }, markAll), tiles);
    const foot = h('div', { class: 'group-foot' }, hint, h('span', { class: 'savebar-btns' }, cancelBtn, saveBtn));
    const el = h('section', { class: 'comp-section', 'data-comp': k },
      h('div', { class: 'row-between comp-head' }, h('div', { class: 'comp-headline' }, h('h2', { class: 'comp-title' }, c.label), chip), editBtn),
      summary, body, foot);
    editing[k] = !sentOf(k);
    const update = () => {
      const on = !!editing[k], dirty = dirtyOf(k), sent = sentOf(k);
      const yes = keys.filter(x => savedDays[x] === 'yes').length, no = keys.filter(x => savedDays[x] === 'no').length, open = keys.filter(x => !savedDays[x]).length;
      paintChip(chip, dirty, sent, isNewGroup(k) && !sent);
      summary.textContent = sent ? `${yes} available · ${no} not available` + (open ? ` · ${open} new date${open > 1 ? 's' : ''} to answer` : '') : 'Not answered yet.';
      summary.hidden = on; body.hidden = !on; foot.hidden = !on; editBtn.hidden = on;
      editBtn.textContent = sent ? 'Edit availability' : 'Give availability';
      const left = keys.filter(x => !days[x]).length;
      hint.textContent = left ? `${left} date${left > 1 ? 's' : ''} not answered yet` : 'All dates answered';
      saveBtn.disabled = !dirty;                          // nothing has changed since the last save
    };
    editBtn.onclick = () => { editing[k] = true; drawStatus(); };
    cancelBtn.onclick = () => {                           // put back what was saved for this group, and fold it away
      for (const x of keysFor(k)) { if (savedDays[x]) days[x] = savedDays[x]; else delete days[x]; paint(x); }
      keys.forEach(x => rowEl[x] && rowEl[x].classList.remove('missing'));
      editing[k] = false; drawStatus();
    };
    const save = busy(saveBtn, async () => {
      if (!dirtyOf(k)) return;
      // Every date of the group must be answered, Available or Not available.
      const blanks = keys.filter(x => !days[x]);
      if (blanks.length) {
        keys.forEach(x => rowEl[x] && rowEl[x].classList.remove('missing'));
        blanks.forEach(x => rowEl[x] && rowEl[x].classList.add('missing'));
        const first = rowEl[blanks[0]];
        if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(`Answer every date before saving ${c.label}: ${blanks.length} left.`, 'err');
        return;
      }
      const before = savedDays;
      const next = { ...savedDays };                      // the other groups stay as last saved
      for (const x of keysFor(k)) { if (days[x]) next[x] = days[x]; else delete next[x]; }
      await put(next, savedPicks);
      savedDays = next;
      lastSaved = { days: next, updatedAt: new Date().toISOString() };
      editing[k] = false;
      drawStatus();
      // Pulling out of a game that is already published: free the slot and tell the appointments officer.
      const w = await recordWithdrawal(store, { umpire: u, before, after: next });
      if (w) {
        // Like "I can't do this": those days leave My appointments until the officer publishes again.
        const at = new Date().toISOString();
        declined = [...declined.filter(x => !w.games.some(y => y.gameId === x.gameId && y.date === x.date)),
          ...w.games.map(y => ({ roundId: y.roundId, gameId: y.gameId, comp: y.comp, date: y.date, at }))];
        await put(next, savedPicks);
        for (let i = mine.length - 1; i >= 0; i--) if (gaveBack(mine[i])) mine.splice(i, 1);
        if (!mine.length) apptCard && apptCard.remove();
      }
      if (mine.length) drawAppointments();
      if (w) { const n = new Set(w.games.map(x => x.roundId + '|' + x.gameId)).size;      // a two-day game is one game
        toast(`Saved ${c.label}. You were down for ${n} game${n === 1 ? '' : 's'} on those dates.`, 'warn'); }
      else toast(`${c.label} availability saved`);
    });
    saveBtn.onclick = async () => { await save(); drawStatus(); };   // busy() re-enables the button; put it back to how it should be
    return { el, update };
  });

  // Player umpiring: its own card, with its own Edit, Save and Cancel.
  const puTitle = (pu.title || '').trim() || 'Player umpire';
  const pSummary = h('div', { class: 'group-summary' });
  const pEditBtn = h('button', { class: 'btn small', type: 'button' });
  const pHint = h('span', { class: 'muted' });
  const pCancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const pSave = h('button', { class: 'btn primary', type: 'button' }, `Save ${puTitle}`);
  const pFoot = h('div', { class: 'group-foot' }, pHint, h('span', { class: 'savebar-btns' }, pCancel, pSave));
  const playerCard = h('section', { class: 'comp-section player-card' },
    h('div', { class: 'row-between comp-head' }, h('div', { class: 'comp-headline' }, h('h2', { class: 'comp-title' }, puTitle), statusChips.player), pEditBtn),
    (pu.description || '').trim() && h('p', { class: 'muted group-note' }, (pu.description || '').trim()),
    pSummary, playerBody, pFoot);
  playerCard.hidden = !puOn;
  const updatePlayer = () => {
    const on = playerEditing, n = savedPicks.length, dirty = picksChanged();
    paintChip(statusChips.player, dirty, n > 0, isNewPlayer() && !on);
    setChildren(pSummary, n
      ? h('ul', { class: 'plain muted small' }, savedPicks.map(p => h('li', {}, `${p.dates.map(fmtDay).join(' & ')} · ${gradeShort(p.grade)} · ${p.label}`)))
      : h('p', { class: 'muted' }, 'No games chosen yet.'));
    pSummary.hidden = on; playerBody.hidden = !on; pFoot.hidden = !on; pEditBtn.hidden = on;
    pEditBtn.textContent = n ? 'Edit games' : 'Choose games';
    pHint.textContent = `${picks.length} game${picks.length === 1 ? '' : 's'} chosen`;
    pSave.disabled = !dirty;
  };
  pEditBtn.onclick = () => { playerEditing = true; drawPlayer(); drawStatus(); };
  pCancel.onclick = () => { picks = savedPicks.map(p => ({ ...p, dates: [...p.dates] })); playerEditing = false; drawPlayer(); drawStatus(); };
  const savePlayer = busy(pSave, async () => {
    if (!picksChanged()) return;
    const nextPicks = picks.map(p => ({ ...p, dates: [...p.dates] }));
    await put(savedDays, nextPicks);
    savedPicks = nextPicks;
    lastSaved = { days: savedDays, updatedAt: new Date().toISOString() };
    playerEditing = false;
    drawPlayer(); drawStatus();
    toast(nextPicks.length ? 'Saved. The appointments officer will see the games you chose.' : `${puTitle} saved`);
  });
  pSave.onclick = async () => { await savePlayer(); drawStatus(); };

  drawStatus = () => { groupCards.forEach(g => g.update()); updatePlayer(); };
  drawSummary = drawStatus;
  drawStatus();
  drawPlayer();
  root.append(
    h('div', { class: 'avail-head' }, h('div', { class: 'muted small' }, 'My availability'), h('h2', {}, orgName),
      h('p', { class: 'muted' }, 'Each group is answered and saved on its own: tap Available or Not available for every date, then Save that group.')),
    ...(groupCards.length ? groupCards.map(g => g.el) : [h('p', { class: 'muted' }, 'No upcoming dates.')]),
    playerCard);
  // The member's other associations: a summary card each, opened to edit there.
  const others = h('div', { class: 'other-orgs' });
  root.append(others);
  otherOrgCards(ctx, u.email, today).then(cards => setChildren(others, cards)).catch(e => console.warn('other associations', e));
  return root;
}

// A group the association added after the member last saved, and that they have not answered.
function isNewFor(group, avail) {
  if (!group || !group.addedAt || !avail || !avail.updatedAt) return false;
  return avail.updatedAt < group.addedAt && !Object.keys(avail.days || {}).some(x => x.startsWith(group.key + ':'));
}

function summaryRow(label, sent, yes, no, fresh) {
  return h('li', { class: 'row-between' },
    h('span', {}, h('strong', {}, label), sent && h('span', { class: 'muted' }, ` \u00b7 ${yes} available \u00b7 ${no} not available`)),
    h('span', { class: 'chip ' + (sent ? 'ok' : fresh ? 'new' : 'muted-chip') }, sent ? '\u2713 Submitted' : fresh ? 'Newly Added' : 'Not submitted'));
}

// Summary cards for every other association this member belongs to, read with their member access there.
async function otherOrgCards(ctx, email, today) {
  const { store } = ctx;
  if (!store.listMemberships || !store.memberView) return [];
  const ms = (await store.listMemberships(email)).filter(m => m.orgId !== (store.org && store.org.id) && m.active !== false);
  const cards = [];
  for (const m of ms) {
    try {
      const view = store.memberView(m.orgId);
      const [org, season] = await Promise.all([view.getOrg ? view.getOrg() : null, view.getSeason()]);
      if (!org) continue;
      const avail = season ? await view.getAvailability(season.id, email) : null;
      const groups = (org.groups && org.groups.length) ? org.groups : [{ key: 'all', name: 'All grades' }];
      const comps = season ? upcomingDates(season.calendar, today) : [];
      const saved = (avail && avail.days) || {};
      const ticked = (avail && avail.modes && avail.modes.comps) || [];
      const items = groups.filter(g => comps.some(c => c.comp === g.key) && groupNeedsUmpires(g.key, org.gradeGroups, org.gradeUmpires)).map(g => {
        const keys = comps.filter(c => c.comp === g.key).flatMap(c => c.dates.map(d => availKey(g.key, d)));
        const sent = Object.keys(saved).some(x => x.startsWith(g.key + ':'));
        return summaryRow(g.name, sent, keys.filter(x => saved[x] === 'yes').length, keys.filter(x => saved[x] === 'no').length,
          !sent && isNewFor(g, avail) && !ticked.includes(g.key));
      });
      const pu = org.playerUmpire || {};
      const nPicks = ((avail && avail.picks) || []).filter(p => (p.dates || []).some(d => d >= today)).length;
      cards.push(h('section', { class: 'card my-summary other-org' },
        h('div', { class: 'row-between' }, h('div', {}, h('div', { class: 'muted small' }, 'My availability'), h('h2', {}, org.name || m.orgName || m.orgId)),
          h('button', { class: 'btn', type: 'button', onclick: () => ctx.chooseOrg(m.orgId) }, 'Open')),
        !season ? h('p', { class: 'muted' }, 'The season dates have not been set up yet.')
          : h('ul', { class: 'plain summary-list' }, items.length ? items : h('li', { class: 'muted' }, 'No upcoming dates.'),
            pu.enabled && (pu.groups || []).length > 0 && h('li', { class: 'row-between' },
              h('span', {}, h('strong', {}, (pu.title || '').trim() || 'Player umpire'), nPicks > 0 && h('span', { class: 'muted' }, ` \u00b7 ${nPicks} game${nPicks === 1 ? '' : 's'} chosen`)),
              (fresh => h('span', { class: 'chip ' + (nPicks ? 'ok' : fresh ? 'new' : 'muted-chip') }, nPicks ? '\u2713 Submitted' : fresh ? 'Newly Added' : 'Not submitted'))(
                !nPicks && isNewFor({ key: '\u0000', addedAt: pu.addedAt }, avail) && !(avail && avail.modes && avail.modes.player))))));
    } catch (e) { console.warn('association', m.orgId, e); }
  }
  return cards;
}
