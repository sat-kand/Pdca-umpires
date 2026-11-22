// Edge Function: the only place the PlayHQ key lives.
//
// Called by signed-in officers from the app. It checks the caller is an officer of the association
// named in the request, reads that association's PlayHQ organisation ID from the database itself
// (the browser never sends it, except to check a new one in Settings), then answers from PlayHQ.
//
// Secrets (Dashboard -> Edge Functions -> Secrets; locally supabase/functions/.env, never committed):
//   PLAYHQ_API_KEY   the PlayHQ key
//   PLAYHQ_TENANT    ca
import { createClient } from 'npm:@supabase/supabase-js@2';
import { makePhq, cachedPhq, run, isUuid, PhqError } from './phq.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const key = Deno.env.get('PLAYHQ_API_KEY');
const phq = key ? cachedPhq(makePhq({ key, tenant: Deno.env.get('PLAYHQ_TENANT') || 'ca' })) : null;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (!phq) return reply({ error: 'The PlayHQ key has not been added on the server yet.' });
    const body = await req.json().catch(() => ({}));
    const auth = req.headers.get('Authorization') || '';
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user || !user.email) return reply({ error: 'Sign in first.' }, 401);

    const aid = String(body.associationId || '');
    const { data: officer } = await sb.from('officers').select('email')
      .eq('association_id', aid).eq('email', user.email.toLowerCase()).maybeSingle();
    if (!officer) return reply({ error: 'Only an appointments officer of this association can do that.' }, 403);

    let orgId: string;
    if (body.action === 'check') orgId = String(body.orgId || '').toLowerCase();
    else {
      const { data: assoc } = await sb.from('associations').select('playhq_org_id, plan').eq('id', aid).maybeSingle();
      orgId = (assoc && assoc.playhq_org_id) || '';
    }
    if (!isUuid(orgId)) return reply({ error: "Add your association's PlayHQ organisation ID in Settings first." });

    return reply(await run(String(body.action || ''), body, phq, orgId));
  } catch (e) {
    console.error(e);
    const msg = e instanceof PhqError ? e.message : 'The fixture service had a problem. Try again in a minute.';
    return reply({ error: msg });
  }
});
