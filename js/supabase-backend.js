import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { SUPABASE_CONFIG } from './supabase-config.js?v=23.2';

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
  return {
    ...payload,
    id: row.external_id,
    estudio: row.study,
    assignedValidatorId: row.assigned_validator_id,
    validationStatus: row.status,
    validationResults: row.validation_results || {},
    fecha: row.audit_date || payload.fecha || '',
    fechaValidacion: row.validation_date || '',
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationSeconds: row.duration_seconds,
    _module: row.module,
    _studyId: row.study_id || null,
    _countryId: row.country_id || null,
    _updatedAt: row.updated_at
  };
}

function auditToRow(audit, module, scope) {
  const payload = { ...audit };
  delete payload.validationResults;
  delete payload.validationStatus;
  delete payload.assignedValidatorId;
  delete payload.startedAt;
  delete payload.completedAt;
  delete payload.durationSeconds;
  delete payload.fechaValidacion;
  delete payload._module;
  delete payload._updatedAt;

  return {
    module,
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
      this.currentScope = profile.role === 'supervisor' ? await this.getMyAssignment() : null;
      return { role: profile.role, profile, scope: this.currentScope, validator: null, session };
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

    this.currentScope = profile.role === 'supervisor' ? await this.getMyAssignment() : null;
    if (profile.role === 'supervisor' && !this.currentScope) {
      await this.client.auth.signOut({ scope: 'local' });
      throw new Error('El supervisor aún no tiene un estudio y país asignados.');
    }
    return { profile, scope: this.currentScope };
  }

  async signInSupervisor(identifier, password) {
    return this.signInStaff(identifier, password, 'supervisor');
  }

  async getMyAssignment() {
    this.ensureConfigured();
    const { data, error } = await this.client
      .from('supervisor_assignments')
      .select('id, study_id, country_id, studies(id, name), countries(id, code, name)')
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      study: Array.isArray(data.studies) ? data.studies[0] : data.studies,
      country: Array.isArray(data.countries) ? data.countries[0] : data.countries
    };
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
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  }

  async loadState() {
    this.ensureConfigured();
    const [validatorsResult, auditsResult] = await Promise.all([
      this.client.from('validators').select('id, code, name, email, study, study_id, country_id').eq('is_active', true).order('name'),
      this.client.from('audits').select('*').order('created_at', { ascending: true })
    ]);

    if (validatorsResult.error) throw validatorsResult.error;
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

  async upsertAudits(audits, module) {
    this.ensureConfigured();
    if (!audits?.length) return;
    const rows = audits.map(audit => auditToRow(audit, module, this.currentScope));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.client
        .from('audits')
        .upsert(rows.slice(i, i + 500), { onConflict: 'module,external_id' });
      if (error) throw error;
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
    const { error } = await this.client.rpc('save_audit_progress', {
      p_module: module,
      p_external_id: String(audit.id),
      p_status: audit.validationStatus || 'pendiente',
      p_validation_results: audit.validationResults || {},
      p_started_at: parseDate(audit.startedAt),
      p_completed_at: parseDate(audit.completedAt),
      p_duration_seconds: Number.isFinite(audit.durationSeconds) ? audit.durationSeconds : null,
      p_validation_date: cleanDate(audit.fechaValidacion)
    });
    if (error) throw error;
  }

  async deleteValidator(id) {
    this.ensureConfigured();
    const { error } = await this.client.from('validators').delete().eq('id', id);
    if (error) throw error;
  }

  async deleteAudits(module, study = null) {
    this.ensureConfigured();
    let query = this.client.from('audits').delete().eq('module', module);
    if (study) query = query.eq('study', study);
    const { error } = await query;
    if (error) throw error;
  }

  async loadAdministration() {
    this.ensureConfigured();
    const [countries, studies, profiles, assignments] = await Promise.all([
      this.client.from('countries').select('id, code, name, is_active').order('name'),
      this.client.from('studies').select('id, name, description, is_active').order('name'),
      this.client.from('profiles').select('id, username, display_name, role, is_active').eq('role', 'supervisor').order('display_name'),
      this.client.from('supervisor_assignments').select('id, supervisor_id, study_id, country_id').order('created_at')
    ]);
    const failed = [countries, studies, profiles, assignments].find(result => result.error);
    if (failed?.error) throw failed.error;
    return {
      countries: countries.data || [],
      studies: studies.data || [],
      supervisors: profiles.data || [],
      assignments: assignments.data || []
    };
  }

  async createCountry({ code, name }) {
    this.ensureConfigured();
    const { data, error } = await this.client.from('countries').insert({
      code: String(code || '').trim().toUpperCase(),
      name: String(name || '').trim()
    }).select('id, code, name, is_active').single();
    if (error) throw error;
    return data;
  }

  async createStudy({ name, description = '' }) {
    this.ensureConfigured();
    const { data, error } = await this.client.from('studies').insert({
      name: String(name || '').trim(),
      description: String(description || '').trim()
    }).select('id, name, description, is_active').single();
    if (error) throw error;
    return data;
  }

  async createSupervisor({ username, displayName, password, studyId, countryId }) {
    this.ensureConfigured();
    const { data, error } = await this.client.functions.invoke('manage-supervisors', {
      body: { username, displayName, password, studyId, countryId }
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
    return data.supervisor;
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
      .subscribe();
  }

  unsubscribe() {
    if (!this.client || !this.channel) return;
    this.client.removeChannel(this.channel);
    this.channel = null;
  }
}
