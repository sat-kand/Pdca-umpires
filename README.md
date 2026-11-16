# PDCA Umpire Allocation

A small web app for cricket associations to collect umpire availability and allocate umpires. Built for the Parramatta District Cricket Association (PDCA) and set up so other associations can each have their own separate account.

- **Umpires** sign in, tell us which days they can umpire, and later see their own appointments.
- **The appointments officer** gets each competition's next round from Play Cricket automatically, picks the grades that need umpires, sees who is available for each game, allocates umpires (one or two per game, per day for two-day games), gets warnings for clashes, and publishes a report that matches the one emailed today.

It is a static site (no build step) that runs on **GitHub Pages**, with **Firebase** (free tier) storing the data.

> **Try it first, no setup.** With the default config the app runs in *demo mode*: data stays in your own browser, "sign in" just asks for an email address, and *Load sample data* pulls PDCA's real Senior, T20 and Junior fixtures from Play Cricket (falling back to made-up fixtures if it can't be reached) and adds ten sample umpires with made-up availability. Open `index.html` through any web server (e.g. `python3 -m http.server`) and use `admin@demo.test`.

## How a round works

1. **Open Allocate.** There is nothing to set up: the app reads the Play Cricket fixture list by itself (when it is missing or older than 12 hours) and shows **one tile per competition – Senior, T20 and Junior – for that competition's next round.** Each tile shows the dates, the match types Play Cricket gives its games (`Two Day`, `One Day`, `T20`), how many grades are picked and `filled/needed` umpire slots. If a competition has a two-day round, the one-day games that start on that round's second Saturday get **their own extra tile** (own date, own grades in the popup) so both weeks can be done together. Tiles are grouped into **sets** (the appointment work for one stretch of play) with a line between sets, and **Load more**, centred below, adds the next set.
2. **Click the tile**, then **Select grades** → a popup lists that competition's grades playing the round with a tick box and a game count. The committee usually asks for only some grades, so tick those (use *1 umpire / 2 umpires* per grade when needed). The tile's slot total follows the ticks: 5 grades × 3 one-day games = 0/15. A two-day game counts one slot per day. Your choice is remembered for the next round.
3. **Click the tile** → the **Assign** board for that competition only, listing only the ticked grades (the *Select grades* button is there too). For a two-day game the drop-down lists *Available both days* first, and picking someone for Day 1 also fills Day 2 when they are free. Drop-downs are sorted: available umpires first, then no reply, then unavailable/already busy. ⚠ appears for anything questionable (unavailable, double-booked that day in the same competition). **Suggest allocations** fills only empty slots using umpires who said *Available*, least-used first.
4. **Availability tab** shows everyone's answers for the round and who hasn't replied yet. The **Availability** page in the top bar is the whole season at a glance: a tab per competition, a row per umpire, a column per upcoming playing date (past dates are hidden unless you tick *Show past dates*), with a count of available umpires under each date. Click a cell to override an umpire's answer (✓ → ✗ → blank; a dot marks cells the officer set), click a date to list only the umpires free that day, or type a name to find someone.
5. **Publish** → umpires see their appointments. One button carries the state: **Publish**, then **Published ‹time›** (greyed out) while nothing has changed, then **Re-publish** after any later change (an allocation, the grades picked, a fixture update, or an umpire pulling out), with **Unpublish** beside it. The tile on the Allocate page shows the same status as a tag. Finished rounds move to **Past allocations** at the bottom of the Allocate page; click one to open its final report. **Report & email** → **Download PDF** (made by the app itself, nothing to print), copy the BCC list, or open an email draft.

**Umpire availability** is asked once for the whole season and is **separate per competition**, so an umpire can be available for Senior and not for Junior on the same date, and can be appointed to more than one competition on the same day without a warning. If every game in a competition is the same length (all two-day, or all one-day) umpires answer **by round** (Round 2 → Day 1 / Day 2); if lengths are mixed, as in Juniors, they answer from a **plain list of dates**.

## Members

The **Members** page (formerly Umpires) is the association's list of people. Each member has a **first name**, **last name**, **date of birth**, **address**, email, mobile, **umpire accreditation number** and **membership type** (from the list in Settings; the fee follows the type). Members fill in their own details when they join by the link; officers can correct anything and approve new sign-ups with the **Active** tick. Paste an existing list as `First name, Last name, email, mobile, accreditation no.` lines (the last two optional). The allocation board, dropdowns and reports show the full name.

## Player umpires

Player umpiring is switched on by the appointments officer in **Manage → Settings → Player umpires**, which also holds the line members are shown about it (leave it empty to show nothing). When it is off, members only see **Give my availability**; games already chosen stay on the boards. When it is on, a member can umpire in two ways, and can do both:

- **Give my availability** — tick the competitions they umpire (Senior, Junior, T20, any mix), answer each date for those, and the appointments officer gives them games. The date form sits straight under this option. Competitions they don't tick are hidden from the form, any old answers for them are cleared on save (without asking), and the officer's Availability page doesn't count them as missing.
- **Choose my own games (player umpire)** — Senior games only, as PDCA allows player umpires in the Senior competition alone: pick a round, narrow it to a grade if they like, then choose any game in it (Day 1, Day 2 or both days of a two-day game). Choosing a game marks them available that day. One game per competition per day.

Both are saved with the one **Save** button. When the appointments officer next opens **Allocate** or an **Assign** board, each new choice is put on the board: the game is turned on (so its grade shows as selected for that round) and the member's name is filled in with a **Player umpire** tag. The report and PDF show them as `NAME (PLAYER UMPIRE)`. If the game already has an umpire, a second place is opened; if both places are taken, the game is flagged instead. If a member gives a game back, their name comes off again — unless the officer has already put someone else there, in which case the officer's choice stands. Members choose from a list of each upcoming round's games (`orgs/{id}/fixtures`), which never shows who has been allocated.

## Bringing a season's availability in from a spreadsheet

**Availability → Import from a spreadsheet** takes the sheet an association already keeps (the Google Form responses), so umpires do not answer everything again. Copy the rows out of the sheet, including the heading row, and paste them in, or choose a CSV file.

- **Columns** are matched to the season calendar by round name (`Round 1 - 20th & 27th Sep`) or by the dates written in the heading. A column whose dates are not in this season is reported and skipped.
- **Cells** read `Day 1, Day 2`, `Day 2`, `Not Available`, `Yes`, `No` or blank. Anything else is counted as "not understood" and left alone.
- **Rows** are matched to members by email (if the sheet has an email column) or by name. Tick the box to add the people it does not know as **non-members**, which needs an email for them.
- **Check it** shows what would happen before anything is written. Importing replaces that competition's answers for the dates in the sheet and leaves every other date and competition alone.

### Members and non-members

Only an active member can be appointed, so the availability grid marks anyone else **Non-member** and the count under each date is members only. On the Assign board a non-member who is available appears in their own **Available Non-Member** group at the bottom of the dropdown, and choosing one raises the warning "Not an active member", the same as any other warning.

## Membership and alerts (Settings)

- **Membership**: the **renewal day** — a day and a month, with no year, because membership falls due on the same day every year (PDCA: 30 June) — and the **membership types** the association offers, each with its own fee (Ordinary, Junior, Life, or whatever it uses). Members are given one of these on the Members page. Members who have not renewed by that day are meant to lose their membership; registration, renewal and payment are not built yet.
- **Send alerts to**: where to email when an umpire pulls out.

### Turning down an appointment

A published appointment on the umpire's page carries an **I can't do this** button. Doing nothing means they are standing: there is no "accept". Pressing it marks them **Not available** for that day in the same competition, which runs the withdrawal below, and the appointment is then marked "You said you can't do this".

### When an umpire pulls out after a round is published

If an umpire turns down an appointment, or changes an answer to *Not available* for a date they have already been given a game on, the app takes them off those games (the slots go back to empty and the game is flagged on the board), tells the umpire what happened, shows the officer a banner on the Allocate page until they dismiss it, and queues an email to the **Send alerts to** address.

Sending that email needs the Firebase **Trigger Email from Firestore** extension: install it from the Firebase console (Extensions → Trigger Email), point it at the `mail` collection, and give it an SMTP account to send through. Without the extension everything else still works — the slot is freed and the banner appears — but no email goes out.

## Associations (accounts)

The app holds many associations, each completely separate: its own officers, umpires, Play Cricket link, fixtures, availability and allocations.

- **Starting one:** only the product owner sets an association up, in the Firebase console: add a document to `orgs` (`id` matching the document id, `name`, `playCricketId`, `plan: trial`, `notifyEmail`), then add the first officer at `orgs/{id}/admins/{their email}`. Nobody can create one from inside the app.
- **Manage → Settings** (officers only): rename the association, set its Play Cricket link, add or remove officers, and copy the **link for umpires**. Umpires open that link, sign in, add their name and wait for approval.
- **Switching:** **Manage → Your associations** lists the ones a person belongs to, for anyone in more than one.
- **Read-only:** an association can be set to `plan: suspended` by hand in the Firebase console, which makes it read-only. The tool is free and says nothing about plans or payment.

## One-time setup for the product owner (about 20 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (Analytics not needed).
2. **Build → Firestore Database → Create database** → *production mode* → region **australia-southeast1 (Sydney)**.
3. **Firestore → Rules** → replace everything with the contents of [`firestore.rules`](firestore.rules) → **Publish**.
4. **Project settings (gear) → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig` values into [`js/config.js`](js/config.js).

### 2. Turn on sign-in
**Build → Authentication → Get started → Sign-in method**:
- Enable **Google** (recommended — no sending limits).
- Optionally enable **Email/Password** and tick **Email link (passwordless sign-in)**.

> **Email-link limit:** on Firebase's free *Spark* plan only **5 email-link sign-in emails can be sent per day** (25,000 on the pay-as-you-go *Blaze* plan). That is why *Continue with Google* is the main button.

Then **Authentication → Settings → Authorized domains → Add domain**: `YOUR-GITHUB-USERNAME.github.io`.

### 3. Make yourself the product owner
**Firestore → Start collection** → Collection ID `platformAdmins` → Document ID = **your email address in lower case** → add any field (e.g. `role` = `owner`) → Save. Product owners can change an association's `plan` (open `orgs/{id}` in the console and edit `plan`).

### 4. Publish on GitHub Pages
1. Push these files to the `main` branch.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**.

Free GitHub Pages needs a public repository. That is fine here: the code contains no secrets (the Firebase web config is meant to be public — security comes from the Firestore rules) and the data lives in Firebase, not in the repo.

### 5. Create the first association
In the Firebase console create the PDCA association as described under *Associations* below (a document in `orgs`, then yourself in its `admins`). Then open the site → sign in → **Manage → Members → Add members** → send umpires the link from **Manage → Settings**.

## Notes

- **Fixtures** come from Play Cricket's own website service (`grassrootsapiproxy.cricket.com.au`), the same one the Play Cricket pages use. It is not an officially documented API and Cricket Australia could change it, and its terms ask for written permission before systematically collecting data into a database. PDCA's secretary has agreed to PDCA's use; offering the tool to other associations needs Cricket Australia / PlayHQ's permission first. If it ever stops working the Allocate page says so and offers a retry.
- **Privacy:** other umpires see names on a published round (as on the emailed report) but never email addresses or mobiles. Unpublished allocations are only visible to officers. Umpires cannot approve themselves.
- **Sending allocation emails automatically** would need Firebase Cloud Functions (Blaze plan) or an email service. For now the app prepares the report, the BCC list and a draft; you send it.
- Published rounds update live: if you change an allocation after publishing, umpires see the change.

## Development

```
npm test                   # unit tests for the allocation logic and fixture import (Node 20+, no dependencies)
python3 tests/e2e_demo.py  # browser test of the whole flow in demo mode (needs python playwright + Chrome)
```

`js/logic.js` holds all the allocation rules, `js/fixtures.js` the import, `js/store-*.js` the two back-ends (Firebase and demo), `js/views-*.js` the screens.
