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

function mapValidator(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email || '',
    estudio: row.study,
    studyId: row.study_id || null,
    countryId: row.country_id || null
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

    if (profile?.is_active && (profile.role === 'supervisor' || profile.role === 'admin')) {
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

    const isStaff = profile?.is_active && ['admin', 'supervisor'].includes(profile.role);
    if (profileError || !isStaff || (expectedRole && profile.role !== expectedRole)) {
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

    const { error: authError } = await this.client.auth.signInAnonymously();
    if (authError) {
      throw new Error(`No fue posible iniciar la sesión del validador: ${authError.message}`);
    }

    const { data, error } = await this.client.rpc('claim_validator_code', {
      p_code: String(code || '').trim().toUpperCase()
    });

    if (error || !data?.length) {
      await this.client.auth.signOut({ scope: 'local' });
      throw new Error('Código de validador inválido o inactivo.');
    }
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
      .select('id, code, name, email, study, study_id, country_id')
      .eq('is_active', true)
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
      is_active: true
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

  async importDailyBatch({ audits, module, operationDate, fileName, validators }) {
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

      const { data: activated, error: activateError } = await this.client.rpc('activate_upload_batch', {
        p_batch_id: batch.id
      });
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
    const request = audit._rowId
      ? this.client.rpc('save_audit_progress_v2', { p_audit_id: audit._rowId, ...progress })
      : this.client.rpc('save_audit_progress', {
          p_module: module,
          p_external_id: String(audit.id),
          ...progress
        });
    const { error } = await request;
    if (error) throw error;
  }

  async deleteValidator(id) {
    this.ensureConfigured();
    const { error } = await this.client.from('validators').update({ is_active: false }).eq('id', id);
    if (error) throw error;
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

  async purgeAllAuditData() {
    this.ensureConfigured();
    const { data, error } = await this.client.rpc('purge_all_audit_data', {
      p_confirmation: 'ELIMINAR PRUEBAS'
    });
    if (error) throw error;
    return data || { audits_deleted: 0, batches_deleted: 0 };
  }

  async loadAuditHistory({ module = null, pageSize = 500, onProgress = null } = {}) {
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
      if (this.currentScope?.study?.id) request = request.eq('study_id', this.currentScope.study.id);
      if (this.currentScope?.country?.id) request = request.eq('country_id', this.currentScope.country.id);
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

  async loadAdministration() {
    this.ensureConfigured();
    const [studies, profiles, assignments] = await Promise.all([
      this.client.from('studies').select('id, name, description, is_active').order('name'),
      this.client.from('profiles').select('id, username, display_name, role, is_active').eq('role', 'supervisor').order('display_name'),
      this.client.from('supervisor_assignments').select('id, supervisor_id, study_id, country_id, module').order('created_at')
    ]);
    const failed = [studies, profiles, assignments].find(result => result.error);
    if (failed?.error) throw failed.error;
    return {
      studies: studies.data || [],
      supervisors: profiles.data || [],
      assignments: assignments.data || []
    };
  }

  async createSupervisor({ username, displayName, password, studyIds, module }) {
    return this.manageSupervisor({ action: 'create', username, displayName, password, studyIds, module });
  }

  async resetSupervisorPassword({ supervisorId, password }) {
    return this.manageSupervisor({ action: 'reset_password', supervisorId, password });
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
    return data.supervisor || data;
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
