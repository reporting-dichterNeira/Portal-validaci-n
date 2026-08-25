import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const allowedStudyNames = new Set(['tradicional', 'moderno', 'chile', 'lindley']);
const allowedModules = new Set(['smart', 'blocking']);
const internalCountryCode = 'GLB';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isStrongPassword(password: string) {
  return password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /[0-9]/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

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

  const action = String(body.action ?? 'create');
  const supervisorId = String(body.supervisorId ?? body.userId ?? '').trim();
  const password = String(body.password ?? '');

  if (action === 'reset_password' || action === 'delete' || action === 'update_access') {
    if (!uuidPattern.test(supervisorId)) return json({ error: 'INVALID_USER_ID' }, 400);

    const { data: supervisor, error: supervisorError } = await adminClient
      .from('profiles')
      .select('id, username, display_name, role')
      .eq('id', supervisorId)
      .in('role', ['supervisor', 'visualizer', 'commercial'])
      .maybeSingle();
    if (supervisorError) return json({ error: 'SUPERVISOR_LOOKUP_FAILED', detail: supervisorError.message }, 500);
    if (!supervisor) return json({ error: 'USER_NOT_FOUND' }, 404);

    if (action === 'reset_password') {
      if (!isStrongPassword(password)) return json({ error: 'WEAK_PASSWORD' }, 400);
      const { error: updateError } = await adminClient.auth.admin.updateUserById(supervisorId, { password });
      if (updateError) return json({ error: 'PASSWORD_UPDATE_FAILED', detail: updateError.message }, 409);
      return json({ user: { id: supervisor.id, username: supervisor.username, role: supervisor.role } });
    }

    if (action === 'update_access') {
      const userRole = String(body.userRole ?? '').trim().toLowerCase();
      const rawStudyIds = Array.isArray(body.studyIds) ? body.studyIds : [body.studyId];
      const studyIds = [...new Set(rawStudyIds.map(value => String(value ?? '').trim()).filter(Boolean))];
      const module = String(body.module ?? '').trim().toLowerCase();
      if (!['supervisor', 'visualizer', 'commercial'].includes(userRole)) {
        return json({ error: 'INVALID_USER_ROLE' }, 400);
      }

      let internalCountry: { id: string } | null = null;
      if (userRole === 'supervisor') {
        if (studyIds.length < 1 || studyIds.length > 4 || studyIds.some(id => !uuidPattern.test(id))) {
          return json({ error: 'STUDY_REQUIRED' }, 400);
        }
        if (!allowedModules.has(module)) return json({ error: 'MODULE_REQUIRED' }, 400);
        const results = await Promise.all([
          adminClient.from('studies').select('id, name').in('id', studyIds).eq('is_active', true),
          adminClient.from('countries').select('id').eq('code', internalCountryCode).eq('is_active', true).maybeSingle(),
        ]);
        const studies = results[0].data || [];
        internalCountry = results[1].data;
        if (results[0].error
          || studies.length !== studyIds.length
          || studies.some(study => !allowedStudyNames.has(String(study.name).toLowerCase()))) {
          return json({ error: 'INVALID_STUDY' }, 400);
        }
        if (results[1].error || !internalCountry) {
          return json({ error: 'INTERNAL_SCOPE_NOT_CONFIGURED' }, 500);
        }
      }

      if (userRole === 'supervisor') {
        const { error: removeAssignmentsError } = await adminClient
          .from('supervisor_assignments')
          .delete()
          .eq('supervisor_id', supervisorId);
        if (removeAssignmentsError) return json({ error: 'ASSIGNMENT_UPDATE_FAILED', detail: removeAssignmentsError.message }, 409);
        const assignments = studyIds.map(studyId => ({
          supervisor_id: supervisorId,
          study_id: studyId,
          country_id: internalCountry!.id,
          module,
          created_by: userData.user.id,
        }));
        const { error: assignmentError } = await adminClient.from('supervisor_assignments').insert(assignments);
        if (assignmentError) return json({ error: 'ASSIGNMENT_UPDATE_FAILED', detail: assignmentError.message }, 409);
      }

      const { data: authLookup, error: authLookupError } = await adminClient.auth.admin.getUserById(supervisorId);
      if (authLookupError || !authLookup.user) return json({ error: 'AUTH_USER_LOOKUP_FAILED', detail: authLookupError?.message }, 409);
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(supervisorId, {
        app_metadata: { ...(authLookup.user.app_metadata || {}), role: userRole },
      });
      if (authUpdateError) return json({ error: 'AUTH_ROLE_UPDATE_FAILED', detail: authUpdateError.message }, 409);

      const { error: profileUpdateError } = await adminClient
        .from('profiles')
        .update({ role: userRole })
        .eq('id', supervisorId);
      if (profileUpdateError) return json({ error: 'PROFILE_ROLE_UPDATE_FAILED', detail: profileUpdateError.message }, 409);
      return json({ user: { id: supervisor.id, username: supervisor.username, role: userRole } });
    }

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(supervisorId);
    if (deleteError) return json({ error: 'DELETE_SUPERVISOR_FAILED', detail: deleteError.message }, 409);
    return json({ deleted: true, user: { id: supervisor.id, username: supervisor.username, role: supervisor.role } });
  }

  if (action !== 'create') return json({ error: 'INVALID_ACTION' }, 400);

  const username = String(body.username ?? '').trim().toLowerCase();
  const displayName = String(body.displayName ?? '').trim();
  const rawStudyIds = Array.isArray(body.studyIds) ? body.studyIds : [body.studyId];
  const studyIds = [...new Set(rawStudyIds.map(value => String(value ?? '').trim()).filter(Boolean))];
  const module = String(body.module ?? '').trim().toLowerCase();
  const userRole = String(body.userRole ?? 'supervisor').trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return json({ error: 'INVALID_USERNAME' }, 400);
  }
  if (displayName.length < 3) return json({ error: 'INVALID_DISPLAY_NAME' }, 400);
  if (!isStrongPassword(password)) return json({ error: 'WEAK_PASSWORD' }, 400);
  if (!['supervisor', 'visualizer', 'commercial'].includes(userRole)) {
    return json({ error: 'INVALID_USER_ROLE' }, 400);
  }
  if (userRole === 'supervisor') {
    if (studyIds.length < 1 || studyIds.length > 4 || studyIds.some(id => !uuidPattern.test(id))) {
      return json({ error: 'STUDY_REQUIRED' }, 400);
    }
    if (!allowedModules.has(module)) return json({ error: 'MODULE_REQUIRED' }, 400);
  }

  let studies: Array<{ id: string; name: string }> = [];
  let internalCountry: { id: string } | null = null;
  if (userRole === 'supervisor') {
    const results = await Promise.all([
      adminClient.from('studies').select('id, name').in('id', studyIds).eq('is_active', true),
      adminClient.from('countries').select('id').eq('code', internalCountryCode).eq('is_active', true).maybeSingle(),
    ]);
    studies = results[0].data || [];
    internalCountry = results[1].data;
    if (results[0].error
      || studies.length !== studyIds.length
      || studies.some(study => !allowedStudyNames.has(String(study.name).toLowerCase()))) {
      return json({ error: 'INVALID_STUDY' }, 400);
    }
    if (results[1].error || !internalCountry) {
      return json({ error: 'INTERNAL_SCOPE_NOT_CONFIGURED' }, 500);
    }
  }

  const email = `${username}@portal-validacion.local`;
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: userRole },
  });

  if (createError || !created.user) {
    const alreadyExists = /already.*registered|already.*exists/i.test(createError?.message || '');
    return json({ error: alreadyExists ? 'USERNAME_ALREADY_EXISTS' : 'CREATE_AUTH_USER_FAILED', detail: createError?.message }, 409);
  }

  const userId = created.user.id;
  const { error: profileError } = await adminClient.from('profiles').insert({
    id: userId,
    role: userRole,
    username,
    display_name: displayName,
    is_active: true,
  });

  if (profileError) {
    await adminClient.auth.admin.deleteUser(userId);
    return json({ error: 'CREATE_PROFILE_FAILED', detail: profileError.message }, 409);
  }

  if (userRole === 'supervisor') {
    const assignments = studyIds.map(studyId => ({
      supervisor_id: userId,
      study_id: studyId,
      country_id: internalCountry!.id,
      module,
      created_by: userData.user.id,
    }));
    const { error: assignmentError } = await adminClient.from('supervisor_assignments').insert(assignments);

    if (assignmentError) {
      await adminClient.from('profiles').delete().eq('id', userId);
      await adminClient.auth.admin.deleteUser(userId);
      return json({ error: 'CREATE_ASSIGNMENT_FAILED', detail: assignmentError.message }, 409);
    }
  }

  return json({
    user: { id: userId, username, displayName, role: userRole, studyIds, module },
  }, 201);
});
