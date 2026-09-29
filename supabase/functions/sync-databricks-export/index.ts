import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

// Only the SHA-256 digest is deployed. The staging token itself lives in the
// Databricks secret scope and cannot publish data without supervisor review.
const ingestTokenHash = '64d66952047bf74ef6290a166cf6255b697255c0e5ae019dd8af88bab6947930';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token, x-ingest-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const visibleRoles = new Set(['admin', 'supervisor', 'visualizer']);
const publishingRoles = new Set(['admin', 'supervisor']);

type JsonRecord = Record<string, unknown>;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizePeriod(value: unknown) {
  const period = String(value ?? '').trim();
  return /^20\d{2}-(0[1-9]|1[0-2])$/.test(period) ? period : null;
}

function allowedScheduledPeriods() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const current = `${year}-${String(month).padStart(2, '0')}`;
  const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  return new Set([previous, current]);
}

function toHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hashToken(token: string) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('La función no tiene acceso administrativo a Supabase.');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type AdminClient = ReturnType<typeof createAdminClient>;

async function authorizedUser(req: Request, adminClient: AdminClient) {
  const bearer = req.headers.get('Authorization');
  if (!bearer?.startsWith('Bearer ')) return null;
  const { data: userData, error: userError } = await adminClient.auth.getUser(bearer.slice(7));
  if (userError || !userData.user) return null;
  const { data: profile, error: profileError } = await adminClient.from('profiles')
    .select('role, is_active').eq('id', userData.user.id).maybeSingle();
  if (profileError || !profile?.is_active || !visibleRoles.has(String(profile.role))) return null;
  return { id: userData.user.id, role: String(profile.role) };
}

function publicJob(job: JsonRecord, preview: JsonRecord[] = []) {
  return {
    id: job.id,
    periodMonth: job.period_month,
    status: job.status,
    rowsStaged: job.rows_staged,
    error: job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    preview,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return respond({ error: 'METHOD_NOT_ALLOWED' }, 405);

  let body: JsonRecord;
  try {
    body = await req.json();
  } catch {
    return respond({ error: 'INVALID_JSON' }, 400);
  }
  const action = String(body.action ?? '');

  try {
    const adminClient = createAdminClient();

    if (action === 'begin') {
      const token = req.headers.get('x-ingest-token') || '';
      if (token.length < 40 || await hashToken(token) !== ingestTokenHash) {
        return respond({ error: 'INVALID_INGEST_TOKEN' }, 401);
      }
      const period = normalizePeriod(body.periodMonth);
      if (!period || !allowedScheduledPeriods().has(period)) {
        return respond({ error: 'INVALID_SCHEDULED_MONTH' }, 400);
      }
      const periodMonth = `${period}-01`;
      const now = new Date().toISOString();
      await adminClient.from('admin_databricks_sync_jobs').update({
        status: 'failed', error_message: 'La carga programada expiró.', callback_token_hash: '', updated_at: now,
      }).eq('period_month', periodMonth).in('status', ['starting', 'running']).lt('token_expires_at', now);
      const { data: activeJobs, error: activeError } = await adminClient.from('admin_databricks_sync_jobs')
        .select('id').eq('period_month', periodMonth).in('status', ['starting', 'running']).limit(1);
      if (activeError) throw activeError;
      if (activeJobs?.length) return respond({ error: 'MONTH_ALREADY_STAGING' }, 409);

      const callbackToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const { data: job, error: insertError } = await adminClient.from('admin_databricks_sync_jobs')
        .insert({
          period_month: periodMonth,
          status: 'running',
          callback_token_hash: await hashToken(callbackToken),
          token_expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        })
        .select('id').single();
      if (insertError) throw insertError;
      return respond({ jobId: job.id, callbackToken });
    }

    if (['batch', 'complete', 'failed'].includes(action)) {
      const jobId = String(body.jobId ?? '');
      const callbackToken = req.headers.get('x-sync-token') || '';
      if (!/^[0-9a-f-]{36}$/i.test(jobId) || callbackToken.length < 40) {
        return respond({ error: 'INVALID_CALLBACK' }, 401);
      }
      const { data: job, error: jobError } = await adminClient.from('admin_databricks_sync_jobs')
        .select('id, period_month, status, callback_token_hash, token_expires_at, rows_staged')
        .eq('id', jobId).maybeSingle();
      if (jobError || !job || job.status !== 'running' ||
          new Date(job.token_expires_at).getTime() < Date.now() ||
          job.callback_token_hash !== await hashToken(callbackToken)) {
        return respond({ error: 'INVALID_CALLBACK' }, 401);
      }

      if (action === 'batch') {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const processedCount = Number(body.processedCount);
        if (!rows.length || rows.length > 250 || !Number.isInteger(processedCount) ||
            processedCount < rows.length || processedCount > 1000000) {
          return respond({ error: 'INVALID_BATCH' }, 400);
        }
        const staged = rows.map(raw => {
          const record = raw && typeof raw === 'object' ? raw as JsonRecord : {};
          const auditId = String(record.audit_external_id ?? '').trim();
          if (!/^\d+$/.test(auditId)) throw new Error('Databricks devolvió un ID de auditoría no numérico.');
          const auditDate = record.audit_date == null ? '' : String(record.audit_date);
          if (auditDate && !/^\d{4}-\d{2}-\d{2}$/.test(auditDate)) {
            throw new Error('Databricks devolvió una fecha de auditoría no válida.');
          }
          const safeRecord: Record<string, string | null> = {};
          for (const field of ['audit_status', 'pdv_id', 'country', 'audit_date', 'study', 'wave', 'city', 'channel', 'auditor']) {
            safeRecord[field] = record[field] == null ? null : String(record[field]).slice(0, 1000);
          }
          return { job_id: jobId, audit_external_id: auditId, record: safeRecord };
        });
        const { error: stageError } = await adminClient.from('admin_databricks_sync_stage')
          .upsert(staged, { onConflict: 'job_id,audit_external_id' });
        if (stageError) throw stageError;
        const { error: progressError } = await adminClient.from('admin_databricks_sync_jobs')
          .update({ rows_staged: processedCount, updated_at: new Date().toISOString() }).eq('id', jobId);
        if (progressError) throw progressError;
        return respond({ ok: true });
      }

      if (action === 'complete') {
        const expected = Number(body.expectedCount);
        if (!Number.isInteger(expected) || expected < 1) return respond({ error: 'INVALID_COUNT' }, 400);
        const { count, error: countError } = await adminClient.from('admin_databricks_sync_stage')
          .select('audit_external_id', { count: 'exact', head: true }).eq('job_id', jobId);
        if (countError) throw countError;
        if (count !== expected) return respond({ error: 'SYNC_ROW_COUNT_MISMATCH' }, 409);
        const { error: reviewError } = await adminClient.from('admin_databricks_sync_jobs').update({
          status: 'review', rows_staged: count, callback_token_hash: '', updated_at: new Date().toISOString(),
        }).eq('id', jobId).eq('status', 'running');
        if (reviewError) throw reviewError;
        const { data: older, error: olderError } = await adminClient.from('admin_databricks_sync_jobs')
          .select('id').eq('period_month', job.period_month).eq('status', 'review').neq('id', jobId);
        if (olderError) throw olderError;
        for (const previous of older || []) {
          await adminClient.from('admin_databricks_sync_jobs').update({
            status: 'failed', error_message: 'Sustituida por una carga más reciente.', updated_at: new Date().toISOString(),
          }).eq('id', previous.id);
          await adminClient.from('admin_databricks_sync_stage').delete().eq('job_id', previous.id);
        }
        return respond({ ok: true, rowCount: count, pendingReview: true });
      }

      const message = String(body.message ?? 'Databricks interrumpió la carga.').slice(0, 500);
      await adminClient.from('admin_databricks_sync_jobs').update({
        status: 'failed', error_message: message, callback_token_hash: '', updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      await adminClient.from('admin_databricks_sync_stage').delete().eq('job_id', jobId);
      return respond({ ok: true });
    }

    const user = await authorizedUser(req, adminClient);
    if (!user) return respond({ error: 'AUTH_REQUIRED' }, 401);
    if (!['status', 'approve'].includes(action)) return respond({ error: 'INVALID_ACTION' }, 400);
    const period = normalizePeriod(body.periodMonth);
    if (!period) return respond({ error: 'INVALID_MONTH' }, 400);
    const { data: jobs, error: jobsError } = await adminClient.from('admin_databricks_sync_jobs')
      .select('id, period_month, status, rows_staged, error_message, created_at, updated_at, token_expires_at')
      .eq('period_month', `${period}-01`).order('created_at', { ascending: false }).limit(1);
    if (jobsError) throw jobsError;
    const job = jobs?.[0];
    if (!job) return respond({ job: null });

    if (action === 'approve') {
      if (!publishingRoles.has(user.role)) return respond({ error: 'SUPERVISOR_REQUIRED' }, 403);
      if (job.status !== 'review' || String(body.jobId ?? '') !== job.id) {
        return respond({ error: 'STAGE_NOT_READY' }, 409);
      }
      const { data: rowCount, error: publishError } = await adminClient.rpc('finish_admin_databricks_sync', {
        p_job_id: job.id, p_expected_count: job.rows_staged,
      });
      if (publishError) throw publishError;
      return respond({ job: publicJob({ ...job, status: 'complete', rows_staged: rowCount }) });
    }

    if (job.status === 'running' && new Date(job.token_expires_at).getTime() < Date.now()) {
      await adminClient.from('admin_databricks_sync_jobs').update({
        status: 'failed', error_message: 'La carga programada expiró.', callback_token_hash: '', updated_at: new Date().toISOString(),
      }).eq('id', job.id);
      job.status = 'failed';
      job.error_message = 'La carga programada expiró.';
    }
    let preview: JsonRecord[] = [];
    if (job.status === 'review') {
      const { data: samples, error: sampleError } = await adminClient.from('admin_databricks_sync_stage')
        .select('audit_external_id, record').eq('job_id', job.id)
        .order('audit_external_id', { ascending: true }).limit(12);
      if (sampleError) throw sampleError;
      preview = samples || [];
    }
    return respond({ job: publicJob(job, preview) });
  } catch (error) {
    console.error('Carga programada Databricks:', errorMessage(error));
    return respond({ error: errorMessage(error).slice(0, 500) }, 500);
  }
});
