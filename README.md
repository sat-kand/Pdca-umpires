# PDCA Umpire Allocation

A small web app for the Parramatta District Cricket Association umpires.

- **Umpires** sign in, tell us which days they can umpire, and later see their own appointments.
- **The appointments officer** gets each competition's next round from Play Cricket automatically, picks the grades that need umpires, sees who is available for each game, allocates umpires (one or two per game, per day for two-day games), gets warnings for clashes, and publishes a report that matches the one emailed today.

It is a static site (no build step) that runs on **GitHub Pages**, with **Firebase** (free tier) storing the data.

> **Try it first, no setup.** With the default config the app runs in *demo mode*: data stays in your own browser, "sign in" just asks for an email address, and *Load sample data* pulls PDCA's real Senior, T20 and Junior fixtures from Play Cricket (falling back to made-up fixtures if it can't be reached) and adds ten sample umpires with made-up availability. Open `index.html` through any web server (e.g. `python3 -m http.server`) and use `admin@demo.test`.

## How a round works

1. **Open Rounds.** There is nothing to set up: the app reads the Play Cricket fixture list by itself (when it is missing or older than 12 hours) and shows **one tile per competition – Senior, T20 and Junior – for that competition's next round.** Each tile shows the round, its dates, how many grades are picked and `filled/needed` umpire slots.
2. **Select grades** (button on each tile) → a popup lists that competition's grades playing the round with a tick box and a game count. The committee usually asks for only some grades, so tick those (use *1 umpire / 2 umpires* per grade when needed). The tile's slot total follows the ticks: 5 grades × 3 one-day games = 0/15. A two-day game counts one slot per day. Your choice is remembered for the next round.
3. **Click the tile** → the board for that competition only, listing only the ticked grades (the *Select grades* button is there too). For a two-day game the drop-down lists *Available both days* first, and picking someone for Day 1 also fills Day 2 when they are free. Drop-downs are sorted: available umpires first, then no reply, then unavailable/already busy. ⚠ appears for anything questionable (unavailable, double-booked that day in the same competition). **Suggest allocations** fills only empty slots using umpires who said *Available*, least-used first.
4. **Availability tab** shows everyone's answers for the round and who hasn't replied yet. **Update fixtures** refreshes the round from Play Cricket; changed grounds/times are flagged and allocations are kept.
5. **Published** → umpires see their appointments. **Report & email** → print/save as PDF, copy the BCC list, or open an email draft.

**Umpire availability** is asked once for the whole season and is **separate per competition**, so an umpire can be available for Senior and not for Junior on the same date, and can be appointed to more than one competition on the same day without a warning. If every game in a competition is the same length (all two-day, or all one-day) umpires answer **by round** (Round 2 → Day 1 / Day 2); if lengths are mixed, as in Juniors, they answer from a **plain list of dates**.

## One-time setup (about 20 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (Analytics not needed).
2. **Build → Firestore Database → Create database** → *production mode* → region **australia-southeast1 (Sydney)**.
3. **Firestore → Rules** → replace everything with the contents of [`firestore.rules`](firestore.rules) → **Publish**.
4. **Project settings (gear) → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig` values into [`js/config.js`](js/config.js).

### 2. Turn on sign-in
**Build → Authentication → Get started → Sign-in method**:
- Enable **Google** (recommended — no sending limits).
- Optionally enable **Email/Password** and tick **Email link (passwordless sign-in)**.

> **Email-link limit:** on Firebase's free *Spark* plan only **5 email-link sign-in emails can be sent per day** (25,000 on the pay-as-you-go *Blaze* plan). That is why *Continue with Google* is the main button. If you want email links for everyone, upgrade to Blaze (needs a billing card; this app's usage stays inside the free quotas, and you can set a budget alert).

Then **Authentication → Settings → Authorized domains → Add domain**: `YOUR-GITHUB-USERNAME.github.io`.

### 3. Make yourself an appointments officer
**Firestore → Start collection** → Collection ID `admins` → Document ID = **your email address in lower case** → add any field (e.g. `role` = `officer`) → Save. Repeat for each officer.

### 4. Publish on GitHub Pages
1. Create a repository and push these files to the `main` branch.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**.
3. Open `https://YOUR-GITHUB-USERNAME.github.io/REPO-NAME/`.

Free GitHub Pages needs a public repository. That is fine here: the code contains no secrets (the Firebase web config is meant to be public — security comes from the Firestore rules) and the data lives in Firebase, not in the repo.

### 5. First run
Sign in → **Umpires → Add umpires** → paste `Name, email, mobile` lines (for example from your Google Form responses) → **Rounds** (fixtures load on their own).

## Notes

- **Fixtures** come from Play Cricket's own website service (`grassrootsapiproxy.cricket.com.au`), the same one the Play Cricket pages use. It is not an officially documented API and Cricket Australia could change it, and its terms ask for written permission before systematically collecting data into a database. Ask the PDCA secretary to confirm this is OK. If it ever stops working the Rounds page says so and offers a retry.
- **Privacy:** other umpires see names on a published round (as on the emailed report) but never email addresses or mobiles. Unpublished allocations are only visible to officers. Umpires cannot approve themselves.
- **Sending allocation emails automatically** would need Firebase Cloud Functions (Blaze plan) or an email service. For now the app prepares the report, the BCC list and a draft; you send it.
- Published rounds update live: if you change an allocation after publishing, umpires see the change.

## Development

```
npm test                   # unit tests for the allocation logic and fixture import (Node 20+, no dependencies)
python3 tests/e2e_demo.py  # browser test of the whole flow in demo mode (needs python playwright + Chrome)
```

`js/logic.js` holds all the allocation rules, `js/fixtures.js` the import, `js/store-*.js` the two back-ends (Firebase and demo), `js/views-*.js` the screens.
