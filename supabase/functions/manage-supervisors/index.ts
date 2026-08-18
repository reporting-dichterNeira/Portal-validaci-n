import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const allowedStudyNames = new Set(['tradicional', 'moderno', 'chile', 'lindley']);
const internalCountryCode = 'GLB';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('Authorization');

  if (!supabaseUrl || !serviceRoleKey || !authHeader?.startsWith('Bearer ')) {
    return json({ error: 'AUTH_REQUIRED' }, 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const token = authHeader.slice('Bearer '.length);
  const { data: userData, error: userError } = await adminClient.auth.getUser(token);
  if (userError || !userData.user) return json({ error: 'INVALID_SESSION' }, 401);

  const { data: callerProfile, error: callerError } = await adminClient
    .from('profiles')
    .select('role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (callerError || callerProfile?.role !== 'admin' || !callerProfile.is_active) {
    return json({ error: 'ADMIN_REQUIRED' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const username = String(body.username ?? '').trim().toLowerCase();
  const displayName = String(body.displayName ?? '').trim();
  const password = String(body.password ?? '');
  const studyId = String(body.studyId ?? '').trim();

  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return json({ error: 'INVALID_USERNAME' }, 400);
  }
  const strongPassword = password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /[0-9]/.test(password)
    && /[^A-Za-z0-9]/.test(password);
  if (displayName.length < 3 || !strongPassword || !studyId) {
    return json({ error: 'INVALID_SUPERVISOR_DATA' }, 400);
  }

  const [{ data: study, error: studyError }, { data: internalCountry, error: countryError }] = await Promise.all([
    adminClient.from('studies').select('id, name').eq('id', studyId).eq('is_active', true).maybeSingle(),
    adminClient.from('countries').select('id').eq('code', internalCountryCode).eq('is_active', true).maybeSingle(),
  ]);
  if (studyError || !study || !allowedStudyNames.has(String(study.name).toLowerCase())) {
    return json({ error: 'INVALID_STUDY' }, 400);
  }
  if (countryError || !internalCountry) {
    return json({ error: 'INTERNAL_SCOPE_NOT_CONFIGURED' }, 500);
  }

  const email = `${username}@portal-validacion.local`;
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'supervisor' },
  });

  if (createError || !created.user) {
    return json({ error: 'CREATE_AUTH_USER_FAILED', detail: createError?.message }, 409);
  }

  const userId = created.user.id;
  const { error: profileError } = await adminClient.from('profiles').insert({
    id: userId,
    role: 'supervisor',
    username,
    display_name: displayName,
    is_active: true,
  });

  if (profileError) {
    await adminClient.auth.admin.deleteUser(userId);
    return json({ error: 'CREATE_PROFILE_FAILED', detail: profileError.message }, 409);
  }

  const { error: assignmentError } = await adminClient.from('supervisor_assignments').insert({
    supervisor_id: userId,
    study_id: studyId,
    country_id: internalCountry.id,
    created_by: userData.user.id,
  });

  if (assignmentError) {
    await adminClient.from('profiles').delete().eq('id', userId);
    await adminClient.auth.admin.deleteUser(userId);
    return json({ error: 'CREATE_ASSIGNMENT_FAILED', detail: assignmentError.message }, 409);
  }

  return json({
    supervisor: { id: userId, username, displayName, studyId },
  }, 201);
});
