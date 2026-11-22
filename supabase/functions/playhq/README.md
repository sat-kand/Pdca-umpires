# playhq Edge Function

The only place the PlayHQ key lives. The app asks it for seasons, competitions (with grades) and games;
it answers in the shape the app already reads. It checks the caller is an officer of the association,
and reads the association's PlayHQ organisation ID from the database, so the browser cannot ask for
another association's fixtures.

Secrets (never in the repo): `PLAYHQ_API_KEY`, `PLAYHQ_TENANT` (`ca`).
- Hosted: Dashboard -> Edge Functions -> Secrets.
- Local: `supabase/functions/.env` (git-ignored).

Deploy: `supabase functions deploy playhq --project-ref <ref>` (or paste `index.ts` and `phq.js` into
the dashboard's function editor). Logic is tested by `tests/playhq.test.mjs`.
