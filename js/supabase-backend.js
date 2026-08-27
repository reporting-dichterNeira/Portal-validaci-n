import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { SUPABASE_CONFIG } from './supabase-config.js?v=27.0';

const CONFIGURED = Boolean(
  SUPABASE_CONFIG.url &&
  SUPABASE_CONFIG.publishableKey &&
  !SUPABASE_CONFIG.url.includes('YOUR_PROJECT_REF') &&
  !SUPABASE_CONFIG.publishableKey.includes('YOUR_SUPABASE')
);

function cleanDate(value) {
  if (!value) return null;
  return String(value).split('T')[0].split(' ')[0] || null;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isExpiredJwtError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /jwt.*expired|expired.*jwt|token.*expired|expired.*token/.test(message);
}

function mapValidator(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email || '',
    estudio: row.study,
    studyId: row.study_id || null,
    countryId: row.country_id || null,
    isActive: row.is_active !== false
  };
}

function mapAudit(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const batch = Array.isArray(row.upload_batches)
    ? (row.upload_batches[0] || {})
    : (row.upload_batches || {});
  const validator = Array.isArray(row.validators)
    ? (row.validators[0] || {})
    : (row.validators || {});
  const operationDate = row.batch_operation_date || batch.operation_date || null;
  return {
    ...payload,
    id: row.external_id,
    estudio: row.study,
    assignedValidatorId: row.assigned_validator_id,
    validationStatus: row.status,
    validationResults: row.validation_results || {},
    fecha: operationDate || row.audit_date || payload.fecha || '',
    fechaValidacion: row.validation_date || '',
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationSeconds: row.duration_seconds,
    _rowId: row.id || null,
    _batchId: row.batch_id || null,
    _module: row.module,
    _studyId: row.study_id || null,
    _countryId: row.country_id || null,
    _updatedAt: row.updated_at,
    _batchOperationDate: operationDate,
    _batchStatus: row.batch_status || batch.status || null,
    _batchSourceFilename: row.batch_source_filename || batch.source_filename || '',
    _validatorCode: row.validator_code || validator.code || '',
    _validatorName: row.validator_name || validator.name || ''
  };
}

function auditToRow(audit, module, scope, batchId = null) {
  const payload = { ...audit };
  delete payload.validationResults;
  delete payload.validationStatus;
  delete payload.assignedValidatorId;
  delete payload.startedAt;
  delete payload.completedAt;
  delete payload.durationSeconds;
  delete payload.fechaValidacion;
  delete payload._module;
  delete payload._rowId;
  delete payload._batchId;
  delete payload._updatedAt;

  return {
    module,
    batch_id: batchId || audit._batchId || null,
    external_id: String(audit.id).trim(),
    study: scope?.study?.name || audit.estudio || audit.modelo || audit.canal || 'Sin estudio',
    study_id: scope?.study?.id || audit._studyId || null,
    country_id: scope?.country?.id || audit._countryId || null,
    assigned_validator_id: audit.assignedValidatorId || null,
    status: audit.validationStatus || 'pendiente',
    audit_date: cleanDate(audit.fecha),
    validation_date: cleanDate(audit.fechaValidacion),
    payload,
    validation_results: audit.validationResults || {},
    started_at: parseDate(audit.startedAt),
    completed_at: parseDate(audit.completedAt),
    duration_seconds: Number.isFinite(audit.durationSeconds) ? audit.durationSeconds : null
  };
}

export class SupabaseBackend {
  constructor() {
    this.configured = CONFIGURED;
    this.client = CONFIGURED
      ? createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        })
      : null;
    this.channel = null;
    this.currentScope = null;
    this.currentAssignments = [];
    // Kept only in memory for the active validator page. It lets the portal
    // restore the anonymous validator session if its refresh token expires.
    this.currentValidatorCode = null;
  }

  ensureConfigured() {
    if (!this.configured || !this.client) {
      throw new Error('Supabase aún no está configurado para este portal.');
    }
  }

  async getSessionContext() {
    if (!this.configured) return { role: null, validator: null, session: null };
    const { data: { session }, error } = await this.client.auth.getSession();
    if (error) throw error;
    if (!session) return { role: null, validator: null, session: null };

    const { data: profile } = await this.client
      .from('profiles')
      .select('role, username, display_name, is_active')
      .eq('id', session.user.id)
      .maybeSingle();

    if (profile?.is_active && ['supervisor', 'admin', 'visualizer', 'commercial'].includes(profile.role)) {
      this.currentAssignments = profile.role === 'supervisor' ? await this.getMyAssignments() : [];
      this.currentScope = null;
      return {
        role: profile.role,
        profile,
        assignments: this.currentAssignments,
        scope: null,
        validator: null,
        session
      };
    }

    const { data: validators, error: validatorError } = await this.client
      .from('validators')
      .select('id, code, name, email, study')
      .limit(1);
    if (validatorError) throw validatorError;

    return {
      role: validators?.length ? 'validator' : null,
      validator: validators?.length ? mapValidator(validators[0]) : null,
      session
    };
  }

  normalizeStaffEmail(identifier) {
    const value = String(identifier || '').trim().toLowerCase();
    return value.includes('@') ? value : `${value}@portal-validacion.local`;
  }

  async signInStaff(identifier, password, expectedRole = null) {
    this.ensureConfigured();
    await this.client.auth.signOut({ scope: 'local' });
    const email = this.normalizeStaffEmail(identifier);
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const { data: profile, error: profileError } = await this.client
      .from('profiles')
      .select('role, username, display_name, is_active')
      .eq('id', data.user.id)
      .maybeSingle();

    const isStaff = profile?.is_active && ['admin', 'supervisor', 'visualizer', 'commercial'].includes(profile.role);
    const visualLogin = expectedRole === 'visualizer' && ['supervisor', 'visualizer', 'commercial'].includes(profile?.role);
    if (profileError || !isStaff || (expectedRole && !visualLogin && profile.role !== expectedRole)) {
      await this.client.auth.signOut({ scope: 'local' });
      throw new Error('La cuenta no tiene permisos para este portal.');
    }

    this.currentAssignments = profile.role === 'supervisor' ? await this.getMyAssignments() : [];
    this.currentScope = null;
    if (profile.role === 'supervisor' && !this.currentAssignments.length) {
      await this.client.auth.signOut({ scope: 'local' });
      throw new Error('El supervisor aún no tiene un estudio y módulo asignados.');
    }
    return { profile, assignments: this.currentAssignments, scope: null };
  }

  async signInSupervisor(identifier, password) {
    return this.signInStaff(identifier, password, 'supervisor');
  }

  async getMyAssignments() {
    this.ensureConfigured();
    const { data, error } = await this.client
      .from('supervisor_assignments')
      .select('id, study_id, country_id, module, studies(id, name), countries(id, code, name)')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(item => ({
      id: item.id,
      module: item.module,
      study: Array.isArray(item.studies) ? item.studies[0] : item.studies,
      country: Array.isArray(item.countries) ? item.countries[0] : item.countries
    })).filter(item => item.study && item.country);
  }

  selectAssignment(assignmentId) {
    const assignment = this.currentAssignments.find(item => item.id === assignmentId) || null;
    this.currentScope = assignment;
    return assignment;
  }

  async signInValidator(code) {
    this.ensureConfigured();
    await this.client.auth.signOut({ scope: 'local' });

    const normalizedCode = String(code || '').trim().toUpperCase();

    const { error: authError } = await this.client.auth.signInAnonymously();
    if (authError) {
      throw new Error(`No fue posible iniciar la sesión del validador: ${authError.message}`);
    }

    const { data, error } = await this.client.rpc('claim_validator_code', {
      p_code: normalizedCode
    });

    if (error || !data?.length) {
      await this.client.auth.signOut({ scope: 'local' });
      throw new Error('Código de validador inválido o inactivo.');
    }
    this.currentValidatorCode = normalizedCode;
    return mapValidator(data[0]);
  }

  async signOut() {
    if (!this.configured) return;
    this.unsubscribe();
    this.currentScope = null;
    this.currentAssignments = [];
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  }

  async loadState() {
    this.ensureConfigured();
    let validatorsRequest = this.client
      .from('validators')
      .select('id, code, name, email, study, study_id, country_id, is_active')
      .order('is_active', { ascending: false })
      .order('name');
    let batchesRequest = this.client.from('upload_batches').select('id').eq('status', 'active');

    if (this.currentScope?.study?.id) {
      validatorsRequest = validatorsRequest
        .eq('study_id', this.currentScope.study.id)
        .eq('country_id', this.currentScope.country.id);
      batchesRequest = batchesRequest
        .eq('study_id', this.currentScope.study.id)
        .eq('country_id', this.currentScope.country.id)
        .eq('module', this.currentScope.module);
    }

    const [validatorsResult, batchesResult] = await Promise.all([validatorsRequest, batchesRequest]);

    if (validatorsResult.error) throw validatorsResult.error;
    if (batchesResult.error) throw batchesResult.error;

    const activeBatchIds = (batchesResult.data || []).map(batch => batch.id);
    const auditsResult = activeBatchIds.length
      ? await this.client
          .from('audits')
          .select('*')
          .in('batch_id', activeBatchIds)
          .order('created_at', { ascending: true })
      : { data: [], error: null };

    if (auditsResult.error) throw auditsResult.error;

    const smartAudits = [];
    const blockingAudits = [];
    for (const row of auditsResult.data || []) {
      const audit = mapAudit(row);
      if (row.module === 'blocking') blockingAudits.push(audit);
      else smartAudits.push(audit);
    }

    return {
      validators: (validatorsResult.data || []).map(mapValidator),
      smartAudits,
      blockingAudits
    };
  }

  async upsertValidators(validators) {
    this.ensureConfigured();
    if (!validators?.length) return;
    const rows = validators.map(v => ({
      id: v.id,
      code: String(v.code).trim().toUpperCase(),
      name: v.name,
      email: v.email || '',
      study: v.estudio,
      study_id: this.currentScope?.study?.id || v.studyId || null,
      country_id: this.currentScope?.country?.id || v.countryId || null,
      is_active: v.isActive !== false
    }));
    const { error } = await this.client.from('validators').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }

  async upsertAudits(audits, module, batchId = null) {
    this.ensureConfigured();
    if (!audits?.length) return;
    let rows = audits
      .map(audit => auditToRow(audit, module, this.currentScope, batchId))
      .filter(row => row.batch_id);
    if (!rows.length) return;

    // A daily batch is always new. Deduplicate repeated Excel IDs before the
    // insert so Postgres never takes the ON CONFLICT update path while the
    // batch is still a draft and intentionally hidden by the SELECT policy.
    if (batchId) {
      rows = [...new Map(rows.map(row => [row.external_id, row])).values()];
    }

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const result = batchId
        ? await this.client.from('audits').insert(chunk)
        : await this.client.from('audits').upsert(chunk, { onConflict: 'batch_id,external_id' });
      if (result.error) {
        const isAuditRlsError = /row-level security policy.*audits|audits.*row-level security policy/i.test(result.error.message || '');
        throw new Error(isAuditRlsError
          ? 'Supabase rechazó el alcance de la carga. Cierra sesión, vuelve a ingresar y confirma que el estudio asignado sea el correcto.'
          : result.error.message);
      }
    }
  }

  async getPendingCarryoverSummary({ operationDate, module }) {
    this.ensureConfigured();
    const { data, error } = await this.client.rpc('get_pending_carryover_summary', {
      p_study_id: this.currentScope?.study?.id || null,
      p_module: module,
      p_operation_date: cleanDate(operationDate)
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !Number(row.pending_count || 0)) return null;
    return {
      previousBatchId: row.previous_batch_id,
      previousOperationDate: row.previous_operation_date,
      pendingCount: Number(row.pending_count || 0),
      pendingSummary: Array.isArray(row.pending_summary) ? row.pending_summary : []
    };
  }

  async importDailyBatch({ audits, module, operationDate, fileName, validators, carryoverAction = 'carry' }) {
    this.ensureConfigured();
    await this.upsertValidators(validators || []);

    const { data: created, error: createError } = await this.client.rpc('create_upload_batch', {
      p_study_id: this.currentScope?.study?.id || null,
      p_module: module,
      p_operation_date: cleanDate(operationDate),
      p_source_filename: String(fileName || ''),
      p_row_count: audits?.length || 0
    });
    if (createError) throw createError;

    const batch = Array.isArray(created) ? created[0] : created;
    if (!batch?.id) throw new Error('Supabase no devolvió el lote de importación.');

    try {
      (audits || []).forEach(audit => {
        audit._batchId = batch.id;
      });
      await this.upsertAudits(audits, module, batch.id);

      let { data: activated, error: activateError } = await this.client.rpc('activate_upload_batch', {
        p_batch_id: batch.id,
        p_carryover_action: carryoverAction
      });

      // Keep the current upload flow available while a project is being
      // upgraded: the prior RPC accepted only p_batch_id.  Retrying with that
      // contract is safe because the first call cannot resolve to the older
      // function, so it has not changed the draft batch.
      if (activateError && /activate_upload_batch|function.*not found|could not find/i.test(activateError.message || '')) {
        ({ data: activated, error: activateError } = await this.client.rpc('activate_upload_batch', {
          p_batch_id: batch.id
        }));
      }
      if (activateError) throw activateError;
      return Array.isArray(activated) ? activated[0] : activated;
    } catch (error) {
      await this.client
        .from('upload_batches')
        .update({ status: 'failed' })
        .eq('id', batch.id)
        .eq('status', 'draft');
      throw error;
    }
  }

  async saveSupervisorState(validators, smartAudits, blockingAudits) {
    await this.upsertValidators(validators);
    await Promise.all([
      this.upsertAudits(smartAudits, 'smart'),
      this.upsertAudits(blockingAudits, 'blocking')
    ]);
  }

  async ensureFreshSessionForWrite() {
    this.ensureConfigured();
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      throw new Error('La sesión venció. Tus respuestas siguen en pantalla: vuelve a ingresar con tu código y guarda nuevamente.');
    }

    // getSession refreshes when needed, but renew a token that is about to
    // expire before starting the RPC so it cannot expire during the save.
    const expiresAt = Number(data.session.expires_at || 0) * 1000;
    if (expiresAt && expiresAt - Date.now() > 60_000) return data.session;

    const { data: refreshed, error: refreshError } = await this.client.auth.refreshSession();
    if (refreshError || !refreshed.session) {
      throw new Error('La sesión venció. Tus respuestas siguen en pantalla: vuelve a ingresar con tu código y guarda nuevamente.');
    }
    return refreshed.session;
  }

  async restoreValidatorSession() {
    if (!this.currentValidatorCode) {
      throw new Error('La sesión venció. Tus respuestas siguen en pantalla: vuelve a ingresar con tu código y guarda nuevamente.');
    }

    await this.client.auth.signOut({ scope: 'local' });
    const { error: authError } = await this.client.auth.signInAnonymously();
    if (authError) {
      throw new Error('No fue posible renovar la sesión. Tus respuestas siguen en pantalla: vuelve a ingresar con tu código y guarda nuevamente.');
    }

    const { data, error } = await this.client.rpc('claim_validator_code', {
      p_code: this.currentValidatorCode
    });
    if (error || !data?.length) {
      throw new Error('No fue posible restaurar la sesión del validador. Tus respuestas siguen en pantalla: vuelve a ingresar con tu código y guarda nuevamente.');
    }
    return mapValidator(data[0]);
  }

  async requestAuditProgressSave(audit, module, progress) {
    const request = audit._rowId
      ? this.client.rpc('save_audit_progress_v2', { p_audit_id: audit._rowId, ...progress })
      : this.client.rpc('save_audit_progress', {
          p_module: module,
          p_external_id: String(audit.id),
          ...progress
        });
    const { data, error } = await request;
    if (error) throw error;
    return Array.isArray(data) ? (data[0] || null) : data;
  }

  async saveAuditProgress(audit, module) {
    this.ensureConfigured();
    const progress = {
      p_status: audit.validationStatus || 'pendiente',
      p_validation_results: audit.validationResults || {},
      p_started_at: parseDate(audit.startedAt),
      p_completed_at: parseDate(audit.completedAt),
      p_duration_seconds: Number.isFinite(audit.durationSeconds) ? audit.durationSeconds : null,
      p_validation_date: cleanDate(audit.fechaValidacion)
    };

    await this.ensureFreshSessionForWrite();
    try {
      const saved = await this.requestAuditProgressSave(audit, module, progress);
      return saved ? mapAudit(saved) : null;
    } catch (error) {
      if (!isExpiredJwtError(error)) throw error;

      // A browser tab may have been inactive during the automatic refresh.
      // Recreate only this validator's anonymous session and retry the exact
      // same audit once, never silently dropping the captured form values.
      await this.restoreValidatorSession();
      const saved = await this.requestAuditProgressSave(audit, module, progress);
      return saved ? mapAudit(saved) : null;
    }
  }

  async deleteValidator(id) {
    this.ensureConfigured();
    const { error } = await this.client.from('validators').update({ is_active: false }).eq('id', id);
    if (error) throw error;
  }

  async setValidatorActive(id, isActive) {
    this.ensureConfigured();
    const { data, error } = await this.client
      .from('validators')
      .update({ is_active: Boolean(isActive) })
      .eq('id', id)
      .select('id, code, name, email, study, study_id, country_id, is_active')
      .single();
    if (error) throw error;
    return mapValidator(data);
  }

  async reassignPendingAudits({ sourceValidatorId, targetValidatorId, module }) {
    this.ensureConfigured();
    const { data, error } = await this.client.rpc('reassign_pending_audits', {
      p_study_id: this.currentScope?.study?.id || null,
      p_module: module,
      p_source_validator_id: sourceValidatorId,
      p_target_validator_id: targetValidatorId
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    return {
      reassignedCount: Number(result?.reassigned_count || 0),
      activeBatchId: result?.active_batch_id || null
    };
  }

  async deleteAudits(module, study = null) {
    this.ensureConfigured();
    const { error } = await this.client.rpc('archive_active_batches', {
      p_study_id: this.currentScope?.study?.id || null,
      p_module: module
    });
    if (error) throw error;
  }

  async loadValidatorHistory({ dateFrom, dateTo, module = null, validatorId = null }) {
    this.ensureConfigured();
    const { data, error } = await this.client.rpc('get_validator_history', {
      p_date_from: cleanDate(dateFrom),
      p_date_to: cleanDate(dateTo),
      p_module: module || null,
      p_validator_id: validatorId || null,
      p_study_id: this.currentScope?.study?.id || null
    });
    if (error) throw error;
    return (data || []).map(row => ({
      validatorId: row.validator_id,
      validatorCode: row.validator_code,
      validatorName: row.validator_name,
      operationDate: row.operation_date,
      module: row.module,
      totalAudits: Number(row.total_audits || 0),
      completedAudits: Number(row.completed_audits || 0),
      inProgressAudits: Number(row.in_progress_audits || 0),
      pendingAudits: Number(row.pending_audits || 0),
      timedAudits: Number(row.timed_audits || 0),
      totalDurationSeconds: Number(row.total_duration_seconds || 0),
      averageDurationSeconds: Number(row.average_duration_seconds || 0),
      firstActivityAt: row.first_activity_at,
      lastActivityAt: row.last_activity_at
    }));
  }

  async loadMyValidatorProductivity({ dateFrom, dateTo }) {
    return this.loadValidatorHistory({
      dateFrom,
      dateTo,
      module: null,
      validatorId: null
    });
  }

  async purgeAllAuditData() {
    this.ensureConfigured();
    const { data, error } = await this.client.rpc('purge_all_audit_data', {
      p_confirmation: 'ELIMINAR PRUEBAS'
    });
    if (error) throw error;
    return data || { audits_deleted: 0, batches_deleted: 0 };
  }

  async loadHistoricalUploadBatches() {
    this.ensureConfigured();
    const { data, error } = await this.client
      .from('upload_batches')
      .select('id, study_id, module, operation_date, source_filename, row_count, status, created_at, activated_at, archived_at')
      .in('status', ['active', 'archived'])
      .order('operation_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async deleteUploadBatch(batchId, confirmation) {
    this.ensureConfigured();
    const parsedBatchId = Number(batchId);
    if (!Number.isSafeInteger(parsedBatchId) || parsedBatchId < 1) {
      throw new Error('Selecciona una carga válida para eliminar.');
    }
    const { data, error } = await this.client.rpc('delete_upload_batch', {
      p_batch_id: parsedBatchId,
      p_confirmation: String(confirmation || '')
    });
    if (error) throw error;
    return data || { batch_id: parsedBatchId, audits_deleted: 0, batches_deleted: 0 };
  }

  async loadAuditHistory({ module = null, pageSize = 500, onProgress = null, ignoreScope = false } = {}) {
    this.ensureConfigured();
    const safePageSize = Math.min(Math.max(Number(pageSize) || 500, 100), 1000);
    const rows = [];
    let cursor = 0;

    while (true) {
      let request = this.client
        .from('audits')
        .select(`
          id, batch_id, module, external_id, study, study_id, country_id,
          assigned_validator_id, status, audit_date, validation_date, payload,
          validation_results, started_at, completed_at, duration_seconds,
          created_at, updated_at,
          upload_batches!inner(operation_date, status, source_filename),
          validators(code, name)
        `)
        .in('upload_batches.status', ['active', 'archived'])
        .gt('id', cursor);

      if (module) request = request.eq('module', module);
      if (!ignoreScope && this.currentScope?.study?.id) request = request.eq('study_id', this.currentScope.study.id);
      if (!ignoreScope && this.currentScope?.country?.id) request = request.eq('country_id', this.currentScope.country.id);
      request = request.order('id', { ascending: true }).limit(safePageSize);

      const { data, error } = await request;
      if (error) throw error;

      const page = data || [];
      rows.push(...page);
      if (typeof onProgress === 'function') onProgress(rows.length);
      if (page.length < safePageSize) break;

      cursor = Number(page[page.length - 1].id || 0);
      if (!cursor) break;
    }

    return rows.map(mapAudit);
  }

  async searchAuditHistory(query, { module = null, limit = 25 } = {}) {
    this.ensureConfigured();
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return [];

    const { data, error } = await this.client.rpc('search_audit_history', {
      p_query: cleanQuery,
      p_module: module || null,
      p_limit: Math.min(Math.max(Number(limit) || 25, 1), 50),
      p_study_id: this.currentScope?.study?.id || null
    });
    if (error) throw error;
    return (data || []).map(mapAudit);
  }

  async searchGlobalAuditHistory(query, { limit = 50 } = {}) {
    this.ensureConfigured();
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const { data, error } = await this.client.rpc('search_global_audit_history', {
      p_query: cleanQuery,
      p_limit: safeLimit
    });
    if (!error) return (data || []).map(mapAudit);

    // Keeps the Operations portal usable while a database deployment catches
    // up. RLS still governs which historical rows the signed-in user can read.
    if (!/search_global_audit_history|PGRST202/i.test(`${error.code || ''} ${error.message || ''}`)) {
      throw error;
    }
    const normalized = cleanQuery.toLowerCase();
    const audits = await this.loadAuditHistory({ pageSize: 1000, ignoreScope: true });
    return audits.filter(audit => (
      String(audit.id || '').toLowerCase() === normalized
      || String(audit.idPDV || '').toLowerCase() === normalized
    )).slice(0, safeLimit);
  }

  async loadAdministration({ operationDate = null } = {}) {
    this.ensureConfigured();
    const selectedDate = cleanDate(operationDate) || new Date().toISOString().slice(0, 10);
    const [studies, profiles, assignments, validators, batches] = await Promise.all([
      this.client.from('studies').select('id, name, description, is_active').order('name'),
      this.client.from('profiles').select('id, username, display_name, role, is_active').in('role', ['admin', 'supervisor', 'visualizer', 'commercial']).order('display_name'),
      this.client.from('supervisor_assignments').select('id, supervisor_id, study_id, country_id, module').order('created_at'),
      this.client.from('validators').select('id, code, name, study, study_id, is_active').order('is_active', { ascending: false }).order('name'),
      this.client
        .from('upload_batches')
        .select('id, study_id, module, operation_date, source_filename, row_count, status, created_by, created_at, activated_at')
        .eq('operation_date', selectedDate)
        .in('status', ['active', 'archived'])
        .order('created_at', { ascending: false })
    ]);
    const failed = [studies, profiles, assignments, validators, batches].find(result => result.error);
    if (failed?.error) throw failed.error;
    const batchIds = (batches.data || []).map(batch => batch.id);
    const audits = batchIds.length
      ? await this.client
          .from('audits')
          .select('id, batch_id, study_id, module, status, assigned_validator_id, started_at, completed_at, validation_date, updated_at')
          .in('batch_id', batchIds)
      : { data: [], error: null };
    if (audits.error) throw audits.error;
    return {
      studies: studies.data || [],
      // Administrators are included only to resolve the author of a batch;
      // they must not appear in the editable list of portal users.
      supervisors: (profiles.data || []).filter(profile => profile.role !== 'admin'),
      batchCreators: profiles.data || [],
      assignments: assignments.data || [],
      validators: validators.data || [],
      batches: batches.data || [],
      audits: audits.data || [],
      operationDate: selectedDate
    };
  }

  async replaceAdminAnalysisImport({ datasetType, sourceFilename, periodMonth, rows }) {
    this.ensureConfigured();
    const table = datasetType === 'alerts'
      ? 'admin_alert_export_records'
      : datasetType === 'editions'
        ? 'admin_edit_export_records'
        : null;
    if (!table) throw new Error('Tipo de importación no válido.');
    const normalizedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodMonth || ''))
      ? `${periodMonth}-01`
      : null;
    if (!normalizedMonth) throw new Error('Selecciona el mes de referencia del export.');

    const { error: deleteError } = await this.client
      .from(table)
      .delete()
      .eq('period_month', normalizedMonth);
    if (deleteError) throw deleteError;

    const rowsForMonth = rows.map(row => ({ ...row, period_month: normalizedMonth }));
    for (let offset = 0; offset < rowsForMonth.length; offset += 500) {
      const { error } = await this.client.from(table).insert(rowsForMonth.slice(offset, offset + 500));
      if (error) throw error;
    }

    const { data: { user } } = await this.client.auth.getUser();
    const { error: importError } = await this.client
      .from('admin_analysis_imports')
      .upsert({
        dataset_type: datasetType,
        period_month: normalizedMonth,
        source_filename: String(sourceFilename || 'archivo_sin_nombre'),
        row_count: rows.length,
        imported_at: new Date().toISOString(),
        imported_by: user?.id || null
      }, { onConflict: 'dataset_type,period_month' });
    if (importError) throw importError;
  }

  async loadAdminAnalysisImports() {
    this.ensureConfigured();
    const { data, error } = await this.client
      .from('admin_analysis_imports')
      .select('dataset_type, period_month, source_filename, row_count, imported_at')
      .order('period_month', { ascending: false })
      .order('dataset_type');
    if (error) throw error;
    return data || [];
  }

  async deleteAdminAnalysisImport(datasetType, periodMonth) {
    this.ensureConfigured();
    const table = datasetType === 'alerts'
      ? 'admin_alert_export_records'
      : datasetType === 'editions'
        ? 'admin_edit_export_records'
        : null;
    if (!table) throw new Error('Tipo de export no válido.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(periodMonth || ''))) {
      throw new Error('Selecciona el mes del export que deseas eliminar.');
    }

    const { error: recordsError } = await this.client
      .from(table)
      .delete()
      .eq('period_month', periodMonth);
    if (recordsError) throw recordsError;

    const { error: importError } = await this.client
      .from('admin_analysis_imports')
      .delete()
      .eq('dataset_type', datasetType)
      .eq('period_month', periodMonth);
    if (importError) throw importError;
  }

  async loadAllAdminAnalysisRows(table, columns) {
    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await this.client
        .from(table)
        .select(columns)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async loadAdminExternalAnalysis() {
    this.ensureConfigured();
    const alertColumns = 'audit_external_id, period_month, is_alert, audit_status, alert_status, alert_label, pdv_id, pdv_name, country, channel, city, auditor, audit_date, wave, study';
    const editColumns = 'audit_external_id, period_month, study, country, audit_status, wave, modifications_count, question_detail, status_changes_count, first_validation_started_at, first_validation_completed_at, first_validator, last_validation_started_at, last_validation_completed_at, last_validator';
    const legacyEditColumns = editColumns.replace(', question_detail', '');
    let imports;
    let alertRecords;
    let editRecords;
    try {
      [imports, alertRecords, editRecords] = await Promise.all([
        this.loadAdminAnalysisImports(),
        this.loadAllAdminAnalysisRows('admin_alert_export_records', alertColumns),
        this.loadAllAdminAnalysisRows('admin_edit_export_records', editColumns)
      ]);
    } catch (error) {
      // The presentation remains usable while the one-time database migration
      // is being applied. New detail values become available automatically
      // after the column exists and the monthly file is uploaded again.
      if (!/question_detail|column .*does not exist|PGRST204/i.test(String(error?.message || error))) throw error;
      [imports, alertRecords, editRecords] = await Promise.all([
        this.loadAdminAnalysisImports(),
        this.loadAllAdminAnalysisRows('admin_alert_export_records', alertColumns),
        this.loadAllAdminAnalysisRows('admin_edit_export_records', legacyEditColumns)
      ]);
    }
    return {
      imports,
      alertRecords,
      editRecords
    };
  }

  async createSupervisor({ username, displayName, password, studyIds, module, modules = [] }) {
    return this.createPortalUser({ username, displayName, password, studyIds, module, modules, userRole: 'supervisor' });
  }

  async createPortalUser({ username, displayName, password, userRole, studyIds = [], module = null, modules = [] }) {
    const selectedModules = [...new Set((Array.isArray(modules) && modules.length ? modules : [module]).filter(Boolean))];
    return this.manageSupervisor({ action: 'create', username, displayName, password, userRole, studyIds, module: selectedModules[0] || null, modules: selectedModules });
  }

  async resetSupervisorPassword({ supervisorId, password }) {
    return this.manageSupervisor({ action: 'reset_password', supervisorId, password });
  }

  async updatePortalUserAccess({ supervisorId, userRole, studyIds = [], module = null, modules = [] }) {
    const selectedModules = [...new Set((Array.isArray(modules) && modules.length ? modules : [module]).filter(Boolean))];
    return this.manageSupervisor({ action: 'update_access', supervisorId, userRole, studyIds, module: selectedModules[0] || null, modules: selectedModules });
  }

  async deleteSupervisor({ supervisorId }) {
    return this.manageSupervisor({ action: 'delete', supervisorId });
  }

  async manageSupervisor(body) {
    this.ensureConfigured();
    const { data, error } = await this.client.functions.invoke('manage-supervisors', {
      body
    });
    if (error) {
      let detail = error.message;
      try {
        const payload = await error.context?.json();
        detail = payload?.detail || payload?.error || detail;
      } catch {
        // Keep the SDK message when the response has no JSON body.
      }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.detail || data.error);
    return data.user || data.supervisor || data;
  }

  subscribe(onChange) {
    if (!this.configured || !this.client || this.channel) return;
    this.channel = this.client
      .channel('validaflow-audits')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'audits'
      }, payload => onChange(payload))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'upload_batches',
        filter: 'status=eq.active'
      }, payload => onChange(payload))
      .subscribe();
  }

  unsubscribe() {
    if (!this.client || !this.channel) return;
    this.client.removeChannel(this.channel);
    this.channel = null;
  }
}
