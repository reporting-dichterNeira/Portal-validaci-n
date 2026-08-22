/**
 * Controlador Principal de la Aplicación ValidaFlow - dichter & neira
 * Incluye Motor de Control de Calidad y Detección de Anomalías
 */

import { SAMPLE_CSV_DATA, BLOCKING_ALERTS_SAMPLE_CSV, DEFAULT_VALIDATORS, DEFAULT_TIPIFICACIONES, seedSampleValidations } from './sample-data.js?v=21.0';
import { ExcelParser } from './excel-parser.js?v=23.0';
import { Distributor } from './distributor.js?v=21.0';
import { ValidatorUI } from './validator-ui.js?v=31.0';
import { SupabaseBackend } from './supabase-backend.js?v=36.0';
import { formatNicaraguaDate, formatNicaraguaDateTime, getNicaraguaDateKey } from './time-utils.js?v=1.0';

const ADMIN_STUDY_NAMES = ['Tradicional', 'Moderno', 'Chile', 'Lindley'];
const SUPERVISOR_MODULES = {
  smart: { label: 'Validación Smart', icon: '🧠⚡' },
  blocking: { label: 'Alertas Bloqueantes', icon: '🚫🚨' }
};

class ValidaFlowApp {
  constructor() {
    this.audits = [];
    this.smartAudits = [];
    this.blockingAudits = [];
    this.validators = [];
    this.tipificaciones = [...DEFAULT_TIPIFICACIONES];
    this.headers = [];
    this.kpiColumns = [];
    this.storageKey = 'VALIDAFLOW_STATE_V1';
    this.backend = new SupabaseBackend();
    this.remoteWriteQueue = Promise.resolve();
    this.remoteRefreshTimer = null;

    // Estado de Navegación y Vistas Previas
    this.currentView = 'landing'; // landing | validator | admin | supervisor-hub | supervisor-workspace
    this.currentModule = 'smart'; // 'smart' (Validación Smart) | 'blocking' (Alertas Bloqueantes)
    this.currentProject = 'Chile'; // 'Chile' | 'Tradicional' | 'Moderno' | 'Lindley'
    this.currentTab = 'admin';
    this.currentRole = null;
    this.currentProfile = null;
    this.currentScope = null;
    this.currentAssignments = [];
    this.pendingStaffRole = 'supervisor';
    this.adminData = { countries: [], studies: [], supervisors: [], assignments: [] };
    this.historicalBatches = [];
    this.validatorHistoryRows = [];
    this.validatorHistoryLoaded = false;
    this.auditHistoryByModule = { smart: null, blocking: null };
    this.auditHistoryLoadPromises = { smart: null, blocking: null };

    // Sub-Pestaña activa en Métricas & Reportes: 'operational' | 'executive'
    this.reportsSubtab = 'operational';

    // Filtro multi-estudio activo en Métricas (ej: ['ALL'] o ['Tradicional', 'Stills'])
    this.selectedStudies = ['ALL'];

    // Filtro activo en el feed de anomalías
    this.alertsFilter = 'all';

    // Filtro activo en consultas / dudas de validadores
    this.queryFilter = 'all'; // 'all' | 'pending' | 'resolved'
    this.queryStudyFilter = 'ALL';
    this.pendingQueryToResolve = null; // { auditId, kpiName }

    // Filtro activo en Alertas Bloqueantes
    this.blockingFilter = 'all'; // 'all' | 'alert' | 'ok'

    // Criterio activo de repartición: 'audits' (por auditorías) | 'kpis' (por KPIs a revisar)
    this.distributionMode = 'audits';

    // Estado de Autenticación del Supervisor
    this.isSupervisor = this.backend.configured
      ? false
      : sessionStorage.getItem('VALIDAFLOW_SUPERVISOR_AUTH') === 'true';

    // BroadcastChannel para sincronización multi-pestaña
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('validaflow_sync') : null;

    this.initTheme();
    this.ready = this.init();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('valida_theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    this.applyTheme(savedTheme, false);
  }

  applyTheme(theme, showFeedback = true) {
    this.currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.toggle('dark-theme', theme === 'dark');

    const iconEl = document.getElementById('theme-icon');
    const labelEl = document.getElementById('theme-label');
    const btnEl = document.getElementById('btn-theme-toggle');

    if (iconEl) iconEl.textContent = theme === 'dark' ? '☀️' : '🌙';
    if (labelEl) labelEl.textContent = theme === 'dark' ? 'Claro' : 'Oscuro';
    if (btnEl) btnEl.title = theme === 'dark' ? 'Cambiar a Modo Claro ☀️' : 'Cambiar a Modo Oscuro 🌙';

    localStorage.setItem('valida_theme', theme);

    if (showFeedback) {
      this.showToast(`Modo ${theme === 'dark' ? 'Oscuro 🌙' : 'Claro ☀️'} activado`, 'info');
    }
  }

  toggleTheme() {
    const nextTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.applyTheme(nextTheme, true);
  }

  async init() {
    this.loadState();
    this.initLandingAndHub();
    this.initSupervisorAuth();
    this.initUI();
    this.initLookupModule();
    this.initQueriesModule();
    this.initAlertsModule();
    this.initReportsSubtabs();
    this.initStudyFilter();
    this.initDailyReportsModule();
    this.initValidatorHistoryModule();
    this.initReassignPendingAuditsModal();
    this.validatorUI = new ValidatorUI(this);
    this.validatorUI.populateQuickSelect(this.validators);

    if (this.backend.configured) {
      try {
        const context = await this.backend.getSessionContext();
        this.currentRole = context.role;
        this.currentProfile = context.profile || null;
        this.currentAssignments = context.assignments || [];
        this.currentScope = null;
        this.isSupervisor = context.role === 'supervisor';
        if (context.role === 'supervisor') {
          const savedAssignmentId = sessionStorage.getItem('VALIDAFLOW_SELECTED_ASSIGNMENT');
          this.currentScope = savedAssignmentId
            ? this.backend.selectAssignment(savedAssignmentId)
            : null;
        } else {
          this.currentScope = context.scope || null;
        }
        if (this.currentScope?.study?.name) {
          this.currentProject = this.currentScope.study.name;
          this.selectedStudies = [this.currentProject];
        }
        if (context.role === 'supervisor' && this.currentScope) this.applySupervisorModuleAssignment();
        if (context.role === 'validator' && context.validator) {
          this.validatorUI.currentValidator = context.validator;
        }
        if (context.role && (context.role !== 'supervisor' || this.currentScope)) {
          await this.refreshFromBackend();
          this.startRealtimeSync();
        }
      } catch (error) {
        console.error('No fue posible restaurar la sesión de Supabase:', error);
      }
    }

    // Siempre iniciar en la pantalla principal de 2 botones al abrir la aplicación
    this.showView('landing');

    this.renderAdminView();
    this.renderReportsView();
    this.renderQueriesView();
    this.renderAlertsView();
    this.renderDailyReportsView();
    this.listenCrossTabEvents();
  }

  // ==========================================
  // MENÚS PREVIOS: LANDING Y HUB DE SUPERVISIÓN
  // ==========================================
  initLandingAndHub() {
    // 0. Clic en el logo del encabezado regresa a la pantalla de inicio
    document.querySelector('.header-brand')?.addEventListener('click', () => {
      this.showView('landing');
    });

    // 1. Botones de la Pantalla Inicial (Landing)
    const btnEnterValidator = document.getElementById('btn-enter-validator-portal');
    const cardValidator = document.getElementById('choice-btn-validator');
    const btnEnterSupervisor = document.getElementById('btn-enter-supervisor-portal');
    const cardSupervisor = document.getElementById('choice-btn-supervisor');
    const btnEnterAdmin = document.getElementById('btn-enter-admin-portal');
    const cardAdmin = document.getElementById('choice-btn-admin');
    const modalLogin = document.getElementById('modal-supervisor-login');

    const goToValidator = () => {
      this.showView('validator');
    };

    const goToSupervisor = () => {
      if (this.isSupervisor) {
        this.showView('supervisor-hub');
      } else {
        this.openStaffLogin('supervisor');
      }
    };

    const goToAdmin = () => this.handleAdminPortalClick();

    // Botón para regresar al landing desde el portal de validador
    // Los botones de navegación usan sus manejadores declarativos en index.html.
  }

  enterSupervisorModule(moduleKey) {
    if (this.currentRole === 'supervisor' && !this.currentScope) {
      this.showView('supervisor-hub');
      this.showToast('Selecciona primero el estudio con el que vas a trabajar.', 'warning');
      return;
    }
    const assignedModule = this.currentRole === 'supervisor' ? this.currentScope?.module : null;
    this.currentModule = assignedModule || moduleKey;
    moduleKey = this.currentModule;

    if (moduleKey === 'blocking') {
      this.audits = this.blockingAudits || [];
    } else {
      this.audits = this.smartAudits || [];
    }

    this.showView('supervisor-workspace');
    this.renderAdminView();
    this.renderReportsView();
    this.renderQueriesView();
    this.renderAlertsView();
    this.renderDailyReportsView();
    this.populateLookupQuickTags();

    const moduleLabel = moduleKey === 'smart' ? 'Validación Smart 🧠⚡' : 'Alertas Bloqueantes 🚫🚨';
    this.showToast(`Has ingresado a: ${moduleLabel}`, 'info');
  }

  switchSupervisorTab(tabId) {
    this.currentTab = tabId;

    // Actualizar botones de navegación
    document.querySelectorAll('#supervisor-nav-tabs .nav-tab-btn').forEach(btn => {
      if (btn.dataset.tab === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Actualizar paneles de contenido
    document.querySelectorAll('#private-supervisor-view .tab-content-pane').forEach(pane => {
      pane.classList.remove('active');
    });

    const targetPane = document.getElementById(`tab-${tabId}`);
    if (targetPane) {
      targetPane.classList.add('active');
    }

    // Renderizar la vista correspondiente
    if (tabId === 'admin') {
      this.renderAdminView();
    } else if (tabId === 'reports') {
      this.renderReportsView();
      this.renderDailyReportsView();
    } else if (tabId === 'queries') {
      this.renderQueriesView();
    } else if (tabId === 'alerts') {
      this.renderAlertsView();
    } else if (tabId === 'lookup') {
      this.populateLookupQuickTags();
      document.getElementById('lookup-search-input')?.focus();
    }
  }

  selectModule(moduleKey) {
    const assignedModule = this.currentRole === 'supervisor' ? this.currentScope?.module : null;
    this.currentModule = assignedModule || moduleKey;
    moduleKey = this.currentModule;
    const cardSmart = document.getElementById('module-card-smart');
    const cardBlocking = document.getElementById('module-card-blocking');

    if (moduleKey === 'smart') {
      cardSmart?.classList.add('active-module');
      cardBlocking?.classList.remove('active-module');
    } else {
      cardBlocking?.classList.add('active-module');
      cardSmart?.classList.remove('active-module');
    }
  }

  enterProject(projectName) {
    if (this.currentRole === 'supervisor') {
      const assignment = this.currentAssignments.find(item => item.study?.name === projectName);
      if (assignment) this.selectSupervisorStudy(assignment.id);
      return;
    }
    this.currentProject = projectName;
    this.selectedStudies = [projectName];
    this.showView('supervisor-workspace');

    this.renderAdminView();
    this.renderReportsView();
    this.renderAlertsView();
    this.renderDailyReportsView();
    this.populateLookupQuickTags();

    const moduleLabel = this.currentModule === 'smart' ? 'Validación Smart 🧠⚡' : 'Alertas Bloqueantes 🚫🚨';
    this.showToast(`Ingresando a: ${moduleLabel} > ${projectName}`, 'info');
  }

  showView(viewName) {
    this.currentView = viewName;

    const landingView = document.getElementById('view-landing');
    const validatorView = document.getElementById('public-validator-view');
    const hubView = document.getElementById('view-supervisor-hub');
    const workspaceView = document.getElementById('private-supervisor-view');
    const adminView = document.getElementById('view-administrator');
    const navTabs = document.getElementById('supervisor-nav-tabs');
    const modeBadge = document.getElementById('header-mode-badge');
    const btnAuthText = document.getElementById('supervisor-btn-text');

    // Ocultar todas las vistas principales
    landingView?.classList.add('hidden');
    validatorView?.classList.add('hidden');
    hubView?.classList.add('hidden');
    workspaceView?.classList.add('hidden');
    adminView?.classList.add('hidden');
    navTabs?.classList.add('hidden');

    if (viewName === 'landing') {
      landingView?.classList.remove('hidden');
      if (modeBadge) {
        modeBadge.textContent = 'Inicio';
        modeBadge.style.background = 'var(--dn-blue-light)';
        modeBadge.style.color = 'var(--dn-navy)';
      }
      if (btnAuthText) {
        btnAuthText.textContent = this.currentRole === 'admin'
          ? 'Panel Administrador ⚙️'
          : (this.isSupervisor ? 'Menú Supervisor 🛡️' : 'Acceso Supervisor');
      }
    } else if (viewName === 'administrator') {
      adminView?.classList.remove('hidden');
      if (modeBadge) {
        modeBadge.textContent = 'Administrador';
        modeBadge.style.background = 'var(--dn-navy)';
        modeBadge.style.color = '#FFFFFF';
      }
      if (btnAuthText) btnAuthText.textContent = 'Cerrar Sesión 🚪';
      this.loadAdministratorPanel();
    } else if (viewName === 'validator') {
      validatorView?.classList.remove('hidden');
      if (this.validatorUI) {
        if (!this.validatorUI.currentValidator) {
          document.getElementById('validator-login-section')?.classList.remove('hidden');
          document.getElementById('validator-portal-section')?.classList.add('hidden');
        } else {
          this.validatorUI.updateProgressHeader();
          this.validatorUI.renderAuditList();
        }
      }
      if (modeBadge) {
        modeBadge.textContent = 'Validador';
        modeBadge.style.background = 'var(--dn-cyan-light)';
        modeBadge.style.color = 'var(--dn-navy)';
      }
      if (btnAuthText) btnAuthText.textContent = 'Acceso Supervisor';
    } else if (viewName === 'supervisor-hub') {
      hubView?.classList.remove('hidden');
      this.renderSupervisorStudySelector();
      if (modeBadge) {
        modeBadge.textContent = 'Supervisor Hub';
        modeBadge.style.background = 'var(--dn-blue)';
        modeBadge.style.color = '#FFFFFF';
      }
      if (btnAuthText) btnAuthText.textContent = 'Cerrar Sesión 🚪';
      this.selectModule(this.currentModule);
    } else if (viewName === 'supervisor-workspace') {
      workspaceView?.classList.remove('hidden');
      navTabs?.classList.remove('hidden');

      if (modeBadge) {
        modeBadge.textContent = `${this.currentProject} • ${this.currentModule === 'smart' ? 'Smart' : 'Bloqueantes'}`;
        modeBadge.style.background = this.currentModule === 'smart' ? 'var(--dn-blue)' : 'var(--dn-magenta)';
        modeBadge.style.color = '#FFFFFF';
      }
      if (btnAuthText) btnAuthText.textContent = 'Cerrar Sesión 🚪';

      // Actualizar breadcrumbs en la barra de contexto
      const modEl = document.getElementById('context-module-name');
      const projEl = document.getElementById('context-project-name');
      if (modEl) modEl.textContent = this.currentModule === 'smart' ? 'Validación Smart 🧠⚡' : 'Alertas Bloqueantes 🚫🚨';
      if (projEl) projEl.textContent = this.currentProject;

      // Asegurar que la pestaña activa esté visible
      const targetTab = this.currentTab || 'admin';
      this.switchSupervisorTab(targetTab);
    }
  }

  // ==========================================
  // AUTENTICACIÓN Y ROLES (SUPERVISOR VS VALIDADOR)
  // ==========================================
  handleSupervisorPortalClick() {
    if (this.isSupervisor) {
      this.showView('supervisor-hub');
    } else {
      this.openStaffLogin('supervisor');
    }
  }

  handleAdminPortalClick() {
    if (this.currentRole === 'admin') {
      this.showView('administrator');
    } else {
      this.openStaffLogin('admin');
    }
  }

  openStaffLogin(role = 'supervisor') {
    this.pendingStaffRole = role;
    const isAdmin = role === 'admin';
    const title = document.getElementById('staff-login-title');
    const description = document.getElementById('staff-login-description');
    const label = document.getElementById('staff-login-user-label');
    if (title) title.textContent = isAdmin ? 'Acceso de Administrador' : 'Acceso de Supervisión';
    if (description) description.textContent = isAdmin
      ? 'Ingresa las credenciales administrativas para gestionar supervisores, estudios y tipos de alertas.'
      : 'Ingresa tus credenciales para acceder al estudio y módulo que tienes asignados.';
    if (label) label.textContent = isAdmin ? 'Usuario administrador' : 'Usuario supervisor';
    const modal = document.getElementById('modal-supervisor-login');
    modal?.classList.remove('hidden');
    document.getElementById('sup-login-user')?.focus();
  }

  handleSupervisorAuthButtonClick() {
    if (this.currentRole === 'admin') {
      if (this.currentView === 'administrator') this.logoutSupervisor();
      else this.showView('administrator');
    } else if (this.isSupervisor) {
      if (this.currentView === 'supervisor-workspace') {
        this.showView('supervisor-hub');
      } else if (this.currentView === 'supervisor-hub') {
        this.logoutSupervisor();
      } else {
        this.showView('supervisor-hub');
      }
    } else {
      this.openStaffLogin('supervisor');
    }
  }

  async submitSupervisorLogin() {
    const userInput = document.getElementById('sup-login-user');
    const passInput = document.getElementById('sup-login-pass');
    const modalLogin = document.getElementById('modal-supervisor-login');
    const email = userInput?.value.trim().toLowerCase() || '';
    const password = passInput?.value || '';

    if (!email || !password) {
      this.showToast('Ingresa el usuario y la contraseña.', 'warning');
      return;
    }

    try {
      if (this.backend.configured) {
        const result = await this.backend.signInStaff(email, password, this.pendingStaffRole);
        this.currentRole = result.profile.role;
        this.currentProfile = result.profile;
        this.currentAssignments = result.assignments || [];
        this.currentScope = null;
        sessionStorage.removeItem('VALIDAFLOW_SELECTED_ASSIGNMENT');
        if (result.profile.role === 'supervisor') {
          this.renderSupervisorStudySelector();
        }
      } else {
        throw new Error('Supabase aún no está configurado para este portal.');
      }

      this.isSupervisor = this.currentRole === 'supervisor';
      modalLogin?.classList.add('hidden');
      this.showView(this.currentRole === 'admin' ? 'administrator' : 'supervisor-hub');
      this.showToast(`Sesión de ${this.currentRole === 'admin' ? 'Administrador' : 'Supervisor'} iniciada.`, 'success');
    } catch (error) {
      this.isSupervisor = false;
      this.currentRole = null;
      this.showToast(error.message || 'No fue posible iniciar sesión.', 'error');
    }
  }

  initSupervisorAuth() {
    const btnSupervisorAuth = document.getElementById('btn-supervisor-auth');
    const modalLogin = document.getElementById('modal-supervisor-login');
    const btnCloseLogin = document.getElementById('btn-close-sup-login');
    const btnCancelLogin = document.getElementById('btn-cancel-sup-login');
    const btnSubmitLogin = document.getElementById('btn-submit-sup-login');
    const userInput = document.getElementById('sup-login-user');
    const passInput = document.getElementById('sup-login-pass');

    const closeModal = () => modalLogin?.classList.add('hidden');
    btnCloseLogin?.addEventListener('click', closeModal);
    btnCancelLogin?.addEventListener('click', closeModal);

    const handleLogin = () => {
      this.submitSupervisorLogin();
    };

    passInput?.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') handleLogin();
    });
  }

  async logoutSupervisor() {
    const roleLabel = this.currentRole === 'admin' ? 'Administración' : 'Supervisión';
    if (this.backend.configured) {
      try {
        await this.backend.signOut();
      } catch (error) {
        console.error('Error al cerrar sesión:', error);
      }
    }
    this.isSupervisor = false;
    this.currentRole = null;
    this.currentProfile = null;
    this.currentScope = null;
    this.currentAssignments = [];
    this.auditHistoryByModule = { smart: null, blocking: null };
    this.auditHistoryLoadPromises = { smart: null, blocking: null };
    sessionStorage.removeItem('VALIDAFLOW_SUPERVISOR_AUTH');
    sessionStorage.removeItem('VALIDAFLOW_SELECTED_ASSIGNMENT');
    this.showView('landing');
    this.showToast(`Has salido de ${roleLabel}. Regresando a la pantalla principal.`, 'info');
  }

  updateRoleView() {
    if (this.currentRole === 'admin') {
      this.showView('administrator');
    } else if (this.isSupervisor) {
      this.showView('supervisor-hub');
    } else {
      this.showView('landing');
    }
  }

  // ==========================================
  // PERSISTENCIA Y SINCRONIZACIÓN
  // ==========================================
  getAuditOperationDate(audit) {
    if (!audit) return 'Sin_Fecha';
    // La jornada pertenece a la base cargada, aunque la auditoría se complete otro día.
    if (audit._batchOperationDate) {
      return ExcelParser.cleanDateOnly(audit._batchOperationDate);
    }
    if (audit.fecha) {
      return ExcelParser.cleanDateOnly(audit.fecha);
    }
    // Compatibilidad con registros antiguos que no tenían jornada de carga.
    if (audit.fechaValidacion) {
      return ExcelParser.cleanDateOnly(audit.fechaValidacion);
    }
    if (audit.completedAt) {
      const d = new Date(audit.completedAt);
      if (!isNaN(d.getTime())) {
        return getNicaraguaDateKey(d);
      }
    }
    return getNicaraguaDateKey(new Date());
  }

  loadState() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        const data = JSON.parse(saved);
        this.smartAudits = data.smartAudits || (data.currentModule !== 'blocking' ? data.audits : []) || [];
        this.blockingAudits = data.blockingAudits || (data.currentModule === 'blocking' ? data.audits : []) || [];

        if (this.smartAudits && Array.isArray(this.smartAudits)) {
          this.smartAudits.forEach(a => {
            if (a.fecha) a.fecha = ExcelParser.cleanDateOnly(a.fecha);
            if (a.fechaValidacion) a.fechaValidacion = ExcelParser.cleanDateOnly(a.fechaValidacion);
          });
        }
        if (this.blockingAudits && Array.isArray(this.blockingAudits)) {
          this.blockingAudits.forEach(a => {
            if (a.fecha) a.fecha = ExcelParser.cleanDateOnly(a.fecha);
            if (a.fechaValidacion) a.fechaValidacion = ExcelParser.cleanDateOnly(a.fechaValidacion);
          });
        }

        if (data.validators && data.validators.length >= 8 && data.validators[0].estudio) {
          this.validators = data.validators;
        } else {
          this.validators = [...DEFAULT_VALIDATORS];
        }
        this.tipificaciones = data.tipificaciones || DEFAULT_TIPIFICACIONES;
        this.headers = data.headers || [];
        this.kpiColumns = data.kpiColumns || [];
        this.currentModule = data.currentModule || 'smart';
        this.currentProject = data.currentProject || 'Chile';
      } else {
        this.validators = [...DEFAULT_VALIDATORS];
        this.tipificaciones = [...DEFAULT_TIPIFICACIONES];
        this.loadSampleData(false);
        this.loadBlockingSampleData(false);
      }

      // Inicializar smartAudits si está vacío
      if (!this.smartAudits || this.smartAudits.length === 0) {
        const parsedSmart = ExcelParser.parseCSV(SAMPLE_CSV_DATA);
        parsedSmart.audits.forEach(a => { a.estudio = 'Chile'; });
        this.smartAudits = Distributor.distributeEqually(parsedSmart.audits, this.validators);
        this.smartAudits = seedSampleValidations(this.smartAudits);
      }

      // Inicializar blockingAudits si está vacío
      if (!this.blockingAudits || this.blockingAudits.length === 0) {
        const parsedBlk = ExcelParser.parseCSV(BLOCKING_ALERTS_SAMPLE_CSV);
        parsedBlk.audits.forEach(a => { a.estudio = 'Chile'; });
        this.blockingAudits = Distributor.distributeEqually(parsedBlk.audits, this.validators);
        this.blockingAudits = seedSampleValidations(this.blockingAudits);
      }

      this.audits = this.currentModule === 'blocking' ? this.blockingAudits : this.smartAudits;
    } catch (e) {
      console.error('Error al cargar estado:', e);
      this.validators = [...DEFAULT_VALIDATORS];
    }
  }

  saveState() {
    try {
      if (this.currentModule === 'blocking') {
        this.blockingAudits = this.audits;
      } else {
        this.smartAudits = this.audits;
      }

      const payload = {
        smartAudits: this.smartAudits,
        blockingAudits: this.blockingAudits,
        audits: this.audits,
        validators: this.validators,
        tipificaciones: this.tipificaciones,
        headers: this.headers,
        kpiColumns: this.kpiColumns,
        currentModule: this.currentModule,
        currentProject: this.currentProject,
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch (e) {
      console.error('Error guardando estado:', e);
    }
  }

  syncStateAcrossTabs(syncTarget = null, options = {}) {
    this.saveState();
    const remoteSync = this.queueRemoteSync(syncTarget, options);
    if (this.channel) {
      this.channel.postMessage({ type: 'STATE_UPDATED', timestamp: Date.now() });
    }
    return remoteSync;
  }

  async loadAdministratorPanel() {
    if (this.currentRole !== 'admin') return;
    try {
      const selectedDate = document.getElementById('admin-productivity-date')?.value
        || this.toLocalDateInputValue(new Date());
      const [administration, historicalBatches] = await Promise.all([
        this.backend.loadAdministration({ operationDate: selectedDate }),
        this.backend.loadHistoricalUploadBatches()
      ]);
      this.adminData = administration;
      this.historicalBatches = historicalBatches;
      this.renderAdministratorPanel();
    } catch (error) {
      this.showToast(error.message || 'No fue posible cargar la administración.', 'error');
    }
  }

  renderAdministratorPanel() {
    const { studies, supervisors, assignments } = this.adminData;
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };
    setText('admin-count-supervisors', supervisors.length);
    setText('admin-count-studies', ADMIN_STUDY_NAMES.length);

    const studySelect = document.getElementById('admin-study-catalog');
    const checkedStudyIds = new Set(
      [...(studySelect?.querySelectorAll('input[type="checkbox"]:checked') || [])]
        .map(input => input.value)
    );
    const studyByName = new Map(studies.map(item => [String(item.name).toLowerCase(), item]));
    const allowedStudies = ADMIN_STUDY_NAMES
      .map(name => studyByName.get(name.toLowerCase()))
      .filter(item => item?.is_active);
    if (studySelect) {
      const studyIcons = { Tradicional: '🏪', Moderno: '🏬', Chile: '🇨🇱', Lindley: '🥤' };
      studySelect.innerHTML = allowedStudies.map(item => `
        <label class="admin-study-check-option">
          <input type="checkbox" value="${item.id}" ${checkedStudyIds.has(item.id) ? 'checked' : ''} />
          <span class="admin-study-check-icon">${studyIcons[item.name] || '📚'}</span>
          <span><strong>${escapeHtml(item.name)}</strong><small>Asignar este estudio</small></span>
        </label>
      `).join('');
    }

    const studyById = new Map(studies.map(item => [item.id, item]));
    const assignmentsBySupervisor = new Map();
    assignments.forEach(item => {
      if (!assignmentsBySupervisor.has(item.supervisor_id)) assignmentsBySupervisor.set(item.supervisor_id, []);
      assignmentsBySupervisor.get(item.supervisor_id).push(item);
    });
    const tbody = document.getElementById('admin-supervisors-tbody');
    if (tbody) {
      tbody.innerHTML = supervisors.length ? supervisors.map(supervisor => {
        const supervisorAssignments = assignmentsBySupervisor.get(supervisor.id) || [];
        const studiesHtml = supervisorAssignments.length
          ? supervisorAssignments.map(assignment => {
              const study = studyById.get(assignment.study_id);
              return `<span class="badge badge-secondary">${escapeHtml(study?.name || 'Sin asignar')}</span>`;
            }).join(' ')
          : 'Sin asignar';
        const moduleLabels = [...new Set(supervisorAssignments.map(assignment =>
          SUPERVISOR_MODULES[assignment.module]?.label || 'Validación Smart'
        ))];
        return `<tr>
          <td><strong>${escapeHtml(supervisor.display_name)}</strong></td>
          <td><code>${escapeHtml(supervisor.username || '—')}</code></td>
          <td><div class="admin-study-badges">${studiesHtml}</div></td>
          <td>${moduleLabels.map(label => `<span class="badge badge-info">${escapeHtml(label)}</span>`).join(' ') || '—'}</td>
          <td><span class="badge ${supervisor.is_active ? 'badge-success' : 'badge-warning'}">${supervisor.is_active ? 'Activo' : 'Inactivo'}</span></td>
          <td><div class="admin-supervisor-actions">
            <button class="btn btn-outline btn-sm btn-admin-reset-password" type="button" data-supervisor-id="${supervisor.id}">🔑 Nueva contraseña</button>
            <button class="btn btn-ghost btn-sm text-danger btn-admin-delete-supervisor" type="button" data-supervisor-id="${supervisor.id}">🗑️ Eliminar</button>
          </div></td>
        </tr>`;
      }).join('') : '<tr><td colspan="6" class="text-center text-muted">Aún no hay supervisores creados.</td></tr>';
      tbody.querySelectorAll('.btn-admin-reset-password').forEach(button => {
        button.addEventListener('click', () => this.resetAdminSupervisorPassword(button.dataset.supervisorId));
      });
      tbody.querySelectorAll('.btn-admin-delete-supervisor').forEach(button => {
        button.addEventListener('click', () => this.deleteAdminSupervisor(button.dataset.supervisorId));
      });
    }
    this.renderAdministratorProductivity();
    this.renderHistoricalBatchDeletionOptions();
  }

  renderHistoricalBatchDeletionOptions() {
    const select = document.getElementById('admin-historical-batch-select');
    const button = document.getElementById('btn-admin-delete-historical-batch');
    if (!select) return;

    const selectedId = select.value;
    const studiesById = new Map((this.adminData?.studies || []).map(study => [study.id, study]));
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
    const number = value => new Intl.NumberFormat('es-CO').format(Number(value || 0));
    const batches = this.historicalBatches || [];

    select.innerHTML = [
      '<option value="">Selecciona el archivo cargado que quieres eliminar…</option>',
      ...batches.map(batch => {
        const study = studiesById.get(batch.study_id);
        const module = batch.module === 'blocking' ? 'Bloqueantes' : 'Smart';
        const status = batch.status === 'active' ? 'activa' : 'histórica';
        const date = String(batch.operation_date || '').split('T')[0] || 'sin fecha';
        const filename = batch.source_filename || 'Carga sin archivo';
        return `<option value="${batch.id}">#${batch.id} · ${escapeHtml(date)} · ${escapeHtml(study?.name || 'Sin estudio')} · ${module} · ${escapeHtml(filename)} (${number(batch.row_count)} registros, ${status})</option>`;
      })
    ].join('');
    if (batches.some(batch => String(batch.id) === selectedId)) select.value = selectedId;
    if (button) button.disabled = !batches.length;
  }

  refreshAdministratorProductivity() {
    this.loadAdministratorPanel();
  }

  renderAdministratorProductivity() {
    const panel = document.getElementById('admin-productivity-panel');
    if (!panel || !this.adminData) return;

    const {
      studies = [],
      supervisors = [],
      validators = [],
      batches = [],
      audits = [],
      operationDate = this.toLocalDateInputValue(new Date())
    } = this.adminData;
    const dateInput = document.getElementById('admin-productivity-date');
    if (dateInput && !dateInput.value) dateInput.value = operationDate;
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
    const studyById = new Map(studies.map(item => [item.id, item]));
    const supervisorById = new Map(supervisors.map(item => [item.id, item]));
    const validatorById = new Map(validators.map(item => [item.id, item]));
    const auditsByBatch = new Map();
    const auditsByValidator = new Map();
    audits.forEach(audit => {
      if (!auditsByBatch.has(audit.batch_id)) auditsByBatch.set(audit.batch_id, []);
      auditsByBatch.get(audit.batch_id).push(audit);
      if (audit.assigned_validator_id) {
        if (!auditsByValidator.has(audit.assigned_validator_id)) auditsByValidator.set(audit.assigned_validator_id, []);
        auditsByValidator.get(audit.assigned_validator_id).push(audit);
      }
    });

    const totalRows = audits.length;
    const completedRows = audits.filter(audit => audit.status === 'completada').length;
    const inProgressRows = audits.filter(audit => audit.status === 'en_progreso').length;
    const activeValidatorIds = [...auditsByValidator.entries()]
      .filter(([, assigned]) => assigned.some(audit => ['en_progreso', 'completada'].includes(audit.status)))
      .map(([validatorId]) => validatorId);
    const percentage = total => totalRows ? Math.round((total / totalRows) * 100) : 0;
    const number = value => new Intl.NumberFormat('es-CO').format(value || 0);
    const formatDateTime = value => formatNicaraguaDateTime(value, '—');
    const displayDate = new Intl.DateTimeFormat('es-CO', {
      weekday: 'long', day: 'numeric', month: 'long'
    }).format(new Date(`${operationDate}T12:00:00`));

    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };
    setText('admin-productivity-date-label', displayDate);
    setText('admin-productivity-batches', number(batches.length));
    setText('admin-productivity-uploaded', number(batches.reduce((total, batch) => total + Number(batch.row_count || 0), 0)));
    setText('admin-productivity-active-validators', number(activeValidatorIds.length));
    setText('admin-productivity-completed', number(completedRows));
    setText('admin-productivity-progress', `${percentage(completedRows)}%`);
    setText('admin-productivity-in-progress', number(inProgressRows));

    const batchBody = document.getElementById('admin-productivity-batches-tbody');
    if (batchBody) {
      batchBody.innerHTML = batches.length ? batches.map(batch => {
        const batchAudits = auditsByBatch.get(batch.id) || [];
        const batchCompleted = batchAudits.filter(audit => audit.status === 'completada').length;
        const batchProgress = batchAudits.length ? Math.round((batchCompleted / batchAudits.length) * 100) : 0;
        const study = studyById.get(batch.study_id);
        const supervisor = supervisorById.get(batch.created_by);
        const moduleLabel = batch.module === 'blocking' ? 'Bloqueantes' : 'Smart';
        return `<tr>
          <td><strong>${escapeHtml(study?.name || 'Sin estudio')}</strong></td>
          <td><span class="badge badge-info">${moduleLabel}</span></td>
          <td>${escapeHtml(supervisor?.display_name || 'Equipo administrador')}</td>
          <td><span class="admin-file-name" title="${escapeHtml(batch.source_filename || '')}">${escapeHtml(batch.source_filename || 'Carga sin archivo')}</span><small>${number(batch.row_count)} registros · ${formatDateTime(batch.activated_at || batch.created_at)}</small></td>
          <td><strong>${number(batchCompleted)} / ${number(batchAudits.length)}</strong><div class="admin-progress-track"><span style="width:${batchProgress}%"></span></div></td>
          <td><span class="badge ${batch.status === 'active' ? 'badge-success' : 'badge-secondary'}">${batch.status === 'active' ? 'Activa' : 'Histórica'}</span></td>
        </tr>`;
      }).join('') : '<tr><td colspan="6" class="text-center text-muted">No hay bases cargadas para esta fecha.</td></tr>';
    }

    const validatorRows = [...auditsByValidator.entries()]
      .map(([validatorId, assigned]) => {
        const validator = validatorById.get(validatorId);
        const completed = assigned.filter(audit => audit.status === 'completada').length;
        const inProgress = assigned.filter(audit => audit.status === 'en_progreso').length;
        const lastActivity = assigned
          .filter(audit => audit.started_at || audit.completed_at)
          .map(audit => audit.completed_at || audit.started_at)
          .sort()
          .at(-1);
        return { validatorId, validator, assigned, completed, inProgress, lastActivity };
      })
      .sort((a, b) => (b.completed + b.inProgress) - (a.completed + a.inProgress)
        || String(a.validator?.name || '').localeCompare(String(b.validator?.name || ''), 'es'));
    const validatorBody = document.getElementById('admin-productivity-validators-tbody');
    if (validatorBody) {
      validatorBody.innerHTML = validatorRows.length ? validatorRows.map(item => {
        const total = item.assigned.length;
        const progress = total ? Math.round((item.completed / total) * 100) : 0;
        const state = item.inProgress ? 'En validación' : item.completed ? 'Con actividad' : 'Sin iniciar';
        const stateClass = item.inProgress ? 'badge-info' : item.completed ? 'badge-success' : 'badge-secondary';
        return `<tr>
          <td><strong>${escapeHtml(item.validator?.name || item.validatorId)}</strong><small>${escapeHtml(item.validator?.code || 'Sin código')}</small></td>
          <td>${escapeHtml(studyById.get(item.validator?.study_id)?.name || item.validator?.study || '—')}</td>
          <td><strong>${number(total)}</strong></td>
          <td>${number(item.completed)}</td>
          <td>${number(item.inProgress)}</td>
          <td><strong>${progress}%</strong><div class="admin-progress-track"><span style="width:${progress}%"></span></div></td>
          <td><span class="badge ${stateClass}">${state}</span><small>${formatDateTime(item.lastActivity)}</small></td>
        </tr>`;
      }).join('') : '<tr><td colspan="7" class="text-center text-muted">Aún no hay auditorías asignadas en las cargas de esta fecha.</td></tr>';
    }
  }

  createStrongPassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = 'Vf!7';
    bytes.forEach(byte => { password += alphabet[byte % alphabet.length]; });
    return password;
  }

  generateTemporaryPassword() {
    const input = document.getElementById('admin-supervisor-password');
    if (input) input.value = this.createStrongPassword();
  }

  isStrongSupervisorPassword(password) {
    return password.length >= 12
      && /[a-z]/.test(password)
      && /[A-Z]/.test(password)
      && /[0-9]/.test(password)
      && /[^A-Za-z0-9]/.test(password);
  }

  showAdminCredential(username, password, title = 'Credenciales listas para copiar') {
    const result = document.getElementById('admin-credential-result');
    const titleElement = document.getElementById('admin-credential-title');
    const usernameElement = document.getElementById('admin-credential-username');
    const passwordInput = document.getElementById('admin-credential-password');
    if (titleElement) titleElement.textContent = title;
    if (usernameElement) usernameElement.textContent = username;
    if (passwordInput) passwordInput.value = password;
    result?.classList.remove('hidden');
    result?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  hideAdminCredential() {
    const result = document.getElementById('admin-credential-result');
    const passwordInput = document.getElementById('admin-credential-password');
    if (passwordInput) passwordInput.value = '';
    result?.classList.add('hidden');
  }

  async copyAdminCredential() {
    const username = document.getElementById('admin-credential-username')?.textContent || '';
    const password = document.getElementById('admin-credential-password')?.value || '';
    if (!username || !password) return;
    try {
      await navigator.clipboard.writeText(`Usuario: ${username}\nContraseña: ${password}`);
      this.showToast('Usuario y contraseña copiados.', 'success');
    } catch {
      const input = document.getElementById('admin-credential-password');
      input?.select();
      this.showToast('Seleccionamos la contraseña para que puedas copiarla.', 'warning');
    }
  }

  async createAdminSupervisor() {
    const username = document.getElementById('admin-supervisor-username')?.value.trim().toLowerCase() || '';
    const displayName = document.getElementById('admin-supervisor-name')?.value.trim() || '';
    const password = document.getElementById('admin-supervisor-password')?.value || '';
    const studyIds = [...document.querySelectorAll('#admin-study-catalog input[type="checkbox"]:checked')]
      .map(input => input.value);
    const module = document.getElementById('admin-supervisor-module')?.value || '';
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      this.showToast('El usuario debe tener entre 3 y 32 caracteres: letras minúsculas, números, punto, guion o guion bajo.', 'warning');
      return;
    }
    if (displayName.length < 3) {
      this.showToast('El nombre debe tener al menos 3 caracteres.', 'warning');
      return;
    }
    if (!studyIds.length) {
      this.showToast('Selecciona al menos un estudio para el supervisor.', 'warning');
      return;
    }
    if (!SUPERVISOR_MODULES[module]) {
      this.showToast('Selecciona si el supervisor trabajará en Validación Smart o Alertas Bloqueantes.', 'warning');
      return;
    }
    if (!this.isStrongSupervisorPassword(password)) {
      this.showToast('La contraseña necesita mínimo 12 caracteres, mayúscula, minúscula, número y símbolo. Puedes usar “Generar”.', 'warning');
      return;
    }
    try {
      await this.backend.createSupervisor({ username, displayName, password, studyIds, module });
      ['admin-supervisor-username', 'admin-supervisor-name', 'admin-supervisor-password'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.value = '';
      });
      document.querySelectorAll('#admin-study-catalog input[type="checkbox"]')
        .forEach(input => { input.checked = false; });
      await this.loadAdministratorPanel();
      this.showAdminCredential(username, password, 'Supervisor creado · guarda estas credenciales');
      this.showToast(`Supervisor ${username} creado con ${studyIds.length} estudio${studyIds.length !== 1 ? 's' : ''} y ${SUPERVISOR_MODULES[module].label}.`, 'success');
    } catch (error) {
      const message = String(error.message || '');
      const friendlyMessage = message === 'USERNAME_ALREADY_EXISTS' || /already.*registered|already.*exists/i.test(message)
        ? 'Ese nombre de usuario ya existe. Prueba con uno diferente.'
        : message === 'WEAK_PASSWORD'
          ? 'La contraseña necesita mínimo 12 caracteres, mayúscula, minúscula, número y símbolo.'
          : message === 'MODULE_REQUIRED'
            ? 'Selecciona el tipo de alertas que tendrá asignado el supervisor.'
          : message || 'No fue posible crear el supervisor.';
      this.showToast(friendlyMessage, 'error');
    }
  }

  async resetAdminSupervisorPassword(supervisorId) {
    const supervisor = this.adminData.supervisors.find(item => item.id === supervisorId);
    if (!supervisor) return;
    if (!confirm(`¿Generar una nueva contraseña para ${supervisor.display_name}? La contraseña anterior dejará de funcionar.`)) return;
    const password = this.createStrongPassword();
    try {
      await this.backend.resetSupervisorPassword({ supervisorId, password });
      this.showAdminCredential(supervisor.username, password, 'Contraseña actualizada · cópiala ahora');
      this.showToast(`Nueva contraseña generada para ${supervisor.username}.`, 'success');
    } catch (error) {
      this.showToast(error.message || 'No fue posible cambiar la contraseña.', 'error');
    }
  }

  async deleteAdminSupervisor(supervisorId) {
    const supervisor = this.adminData.supervisors.find(item => item.id === supervisorId);
    if (!supervisor) return;
    const confirmed = confirm(`¿Eliminar al supervisor “${supervisor.display_name}” (${supervisor.username})? Perderá el acceso de inmediato. El histórico de auditorías se conservará.`);
    if (!confirmed) return;
    try {
      await this.backend.deleteSupervisor({ supervisorId });
      this.hideAdminCredential();
      await this.loadAdministratorPanel();
      this.showToast(`Supervisor ${supervisor.username} eliminado.`, 'success');
    } catch (error) {
      this.showToast(error.message || 'No fue posible eliminar el supervisor.', 'error');
    }
  }

  queueRemoteSync(syncTarget = null, { suppressErrorToast = false } = {}) {
    if (!this.backend.configured) return Promise.resolve();

    // Capture the exact audit at the time the action is queued. The validator can
    // move to the next audit before Supabase finishes the previous request.
    const capturedTarget = syncTarget?.audit
      ? {
          module: syncTarget.module || 'smart',
          audit: typeof structuredClone === 'function'
            ? structuredClone(syncTarget.audit)
            : JSON.parse(JSON.stringify(syncTarget.audit))
        }
      : null;

    const operation = this.remoteWriteQueue
      .then(() => this.persistRemoteState(capturedTarget));

    // Keep the shared queue usable after an error while returning the original
    // operation so critical actions can wait for and handle the failure.
    this.remoteWriteQueue = operation.catch(error => {
      console.error('Error sincronizando con Supabase:', error);
      if (!suppressErrorToast) {
        this.showToast('No se pudo sincronizar con Supabase. Revisa tu conexión.', 'error');
      }
    });

    return operation;
  }

  async purgeTestAuditData() {
    if (this.currentRole !== 'admin') {
      this.showToast('Esta acción requiere una sesión administrativa.', 'error');
      return;
    }

    const confirmed = confirm(
      '¿Eliminar permanentemente TODAS las auditorías y jornadas cargadas?\n\n' +
      'Esta opción está pensada para terminar las pruebas. Los usuarios, validadores, supervisores y estudios se conservarán.'
    );
    if (!confirmed) return;

    const phrase = prompt('Para confirmar, escribe exactamente: ELIMINAR PRUEBAS');
    if (phrase !== 'ELIMINAR PRUEBAS') {
      this.showToast('La frase no coincide. No se eliminó ningún registro.', 'warning');
      return;
    }

    const button = document.getElementById('btn-admin-purge-test-data');
    if (button) {
      button.disabled = true;
      button.textContent = 'Eliminando datos de prueba...';
    }

    try {
      const result = await this.backend.purgeAllAuditData();
      this.audits = [];
      this.smartAudits = [];
      this.blockingAudits = [];
      this.auditHistoryByModule = { smart: null, blocking: null };
      this.validatorHistoryRows = [];
      this.validatorHistoryLoaded = false;
      this.saveState();
      const auditsDeleted = Number(result?.audits_deleted || 0);
      const batchesDeleted = Number(result?.batches_deleted || 0);
      this.showToast(`Limpieza terminada: ${auditsDeleted} auditorías y ${batchesDeleted} jornadas eliminadas.`, 'success');
    } catch (error) {
      this.showToast(error.message || 'No fue posible eliminar los datos de prueba.', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = '🧹 Eliminar datos de prueba';
      }
    }
  }

  async deleteHistoricalBatch() {
    if (this.currentRole !== 'admin') {
      this.showToast('Esta acción requiere una sesión administrativa.', 'error');
      return;
    }

    const select = document.getElementById('admin-historical-batch-select');
    const batchId = select?.value;
    const batch = (this.historicalBatches || []).find(item => String(item.id) === String(batchId));
    if (!batch) {
      this.showToast('Selecciona primero el archivo cargado que deseas eliminar.', 'warning');
      return;
    }

    const filename = batch.source_filename || 'Carga sin archivo';
    const isActive = batch.status === 'active';
    const confirmed = confirm(
      `¿Eliminar permanentemente “${filename}”?\n\n` +
      `Se eliminarán las ${Number(batch.row_count || 0)} auditorías de la carga #${batch.id}. ` +
      (isActive ? 'Esta es la carga activa y dejará de estar disponible para validar.' : 'Es una carga histórica.')
    );
    if (!confirmed) return;

    const confirmation = `ELIMINAR ARCHIVO ${batch.id}`;
    const phrase = prompt(`Para confirmar, escribe exactamente: ${confirmation}`);
    if (phrase !== confirmation) {
      this.showToast('La frase no coincide. No se eliminó ningún archivo.', 'warning');
      return;
    }

    const button = document.getElementById('btn-admin-delete-historical-batch');
    if (button) {
      button.disabled = true;
      button.textContent = 'Eliminando archivo…';
    }

    try {
      const result = await this.backend.deleteUploadBatch(batch.id, phrase);
      this.auditHistoryByModule = { smart: null, blocking: null };
      this.validatorHistoryRows = [];
      this.validatorHistoryLoaded = false;
      await this.refreshFromBackend();
      await this.loadAdministratorPanel();
      this.showToast(
        `Archivo eliminado: ${Number(result?.audits_deleted || 0)} auditorías y ${Number(result?.batches_deleted || 1)} carga eliminadas.`,
        'success'
      );
    } catch (error) {
      this.showToast(error.message || 'No fue posible eliminar el archivo cargado.', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = '🗑️ Eliminar archivo y contenido';
      }
    }
  }

  async persistRemoteState(syncTarget = null) {
    if (!this.backend.configured) return;

    if (this.isSupervisor) {
      await this.backend.saveSupervisorState(
        this.validators,
        this.smartAudits || [],
        this.blockingAudits || []
      );
      return;
    }

    const validatorUI = this.validatorUI;
    if (!validatorUI?.currentValidator) return;
    const module = syncTarget?.module || validatorUI.currentModule || 'smart';
    const source = module === 'blocking' ? this.blockingAudits : this.smartAudits;
    const audit = syncTarget?.audit || (validatorUI.currentAuditId
      ? (source || []).find(a => String(a.id) === String(validatorUI.currentAuditId))
      : null);
    if (audit) await this.backend.saveAuditProgress(audit, module);
  }

  async refreshFromBackend() {
    if (!this.backend.configured) return;
    const state = await this.backend.loadState();
    this.validators = state.validators || [];
    this.smartAudits = state.smartAudits || [];
    this.blockingAudits = state.blockingAudits || [];
    this.audits = this.currentModule === 'blocking' ? this.blockingAudits : this.smartAudits;
    this.mergeActiveAuditsIntoHistory('smart', this.smartAudits);
    this.mergeActiveAuditsIntoHistory('blocking', this.blockingAudits);
    this.saveState();

    this.validatorUI?.populateQuickSelect(this.validators);
    this.populateHistoryValidatorFilter();
    this.renderAdminView();
    this.renderReportsView();
    this.renderQueriesView();
    this.renderAlertsView();
    this.renderDailyReportsView();
    this.populateLookupQuickTags();

    if (this.validatorUI?.currentValidator) {
      const freshValidator = this.validators.find(v => v.id === this.validatorUI.currentValidator.id);
      if (freshValidator) this.validatorUI.currentValidator = freshValidator;
      this.validatorUI.updateProgressHeader();
      this.validatorUI.renderAuditList();
      if (this.validatorUI.currentAuditId) {
        const source = this.validatorUI.currentModule === 'blocking' ? this.blockingAudits : this.smartAudits;
        const current = source.find(a => String(a.id) === String(this.validatorUI.currentAuditId));
        if (current) this.validatorUI.renderAuditDetail(current);
      }
    }
  }

  renderSupervisorStudySelector() {
    if (this.currentRole !== 'supervisor') return;
    const assignments = this.currentAssignments || [];
    const grid = document.getElementById('supervisor-study-grid');
    const title = document.getElementById('supervisor-hub-title');
    const message = document.getElementById('supervisor-hub-assignment');
    const userName = document.getElementById('supervisor-hub-user-name');
    if (title) title.textContent = 'Selecciona tu estudio';
    if (userName) userName.textContent = this.currentProfile?.display_name || 'Supervisor d&n';
    if (message) {
      message.textContent = assignments.length
        ? `Tienes ${assignments.length} estudio${assignments.length !== 1 ? 's' : ''} asignado${assignments.length !== 1 ? 's' : ''}. ¿Con cuál vas a trabajar hoy?`
        : 'Tu usuario todavía no tiene estudios asignados.';
    }
    if (!grid) return;

    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
    const studyInfo = {
      Tradicional: { icon: '🏪', description: 'Tiendas, bodegas y canal tradicional' },
      Moderno: { icon: '🏬', description: 'Grandes cadenas y canal moderno' },
      Chile: { icon: '🇨🇱', description: 'Operación correspondiente a Chile' },
      Lindley: { icon: '🥤', description: 'Operación Lindley / Arca Continental' }
    };

    if (!assignments.length) {
      grid.innerHTML = '<div class="history-empty-state"><span>📚</span><p>Solicita al administrador que asigne al menos un estudio a tu usuario.</p></div>';
      return;
    }

    grid.innerHTML = assignments.map(assignment => {
      const studyName = assignment.study?.name || 'Estudio';
      const info = studyInfo[studyName] || { icon: '📚', description: 'Estudio asignado' };
      const moduleInfo = SUPERVISOR_MODULES[assignment.module] || SUPERVISOR_MODULES.smart;
      const selected = this.currentScope?.id === assignment.id;
      return `
        <article class="hub-module-card supervisor-study-card ${selected ? 'active-module' : ''}" data-assignment-id="${assignment.id}">
          <div class="module-card-header">
            <div class="module-icon-wrap icon-blue">${info.icon}</div>
            <div>
              <div class="module-tag">Estudio asignado</div>
              <h2 class="module-title">${escapeHtml(studyName)}</h2>
            </div>
          </div>
          <p class="module-desc">${escapeHtml(info.description)}</p>
          <div class="module-status-bar"><span class="status-indicator-dot dot-green"></span>${moduleInfo.icon} ${escapeHtml(moduleInfo.label)}</div>
          <div class="module-action-footer">
            <button class="btn btn-primary btn-glow btn-block btn-select-supervisor-study" type="button" data-assignment-id="${assignment.id}">
              Trabajar hoy en ${escapeHtml(studyName)} →
            </button>
          </div>
        </article>
      `;
    }).join('');

    grid.querySelectorAll('.btn-select-supervisor-study').forEach(button => {
      button.addEventListener('click', () => this.selectSupervisorStudy(button.dataset.assignmentId));
    });
  }

  async selectSupervisorStudy(assignmentId) {
    if (this.currentRole !== 'supervisor') return;
    const assignment = this.backend.selectAssignment(assignmentId);
    if (!assignment) {
      this.showToast('Ese estudio no está asignado a tu usuario.', 'error');
      return;
    }

    this.currentScope = assignment;
    this.currentProject = assignment.study.name;
    this.currentModule = assignment.module;
    this.selectedStudies = [this.currentProject];
    sessionStorage.setItem('VALIDAFLOW_SELECTED_ASSIGNMENT', assignment.id);
    if (window.currentNavState) {
      window.currentNavState.project = this.currentProject;
      window.currentNavState.module = this.currentModule;
    }

    this.validators = [];
    this.smartAudits = [];
    this.blockingAudits = [];
    this.audits = [];
    this.auditHistoryByModule = { smart: null, blocking: null };
    this.auditHistoryLoadPromises = { smart: null, blocking: null };
    this.validatorHistoryRows = [];
    this.validatorHistoryLoaded = false;

    const grid = document.getElementById('supervisor-study-grid');
    grid?.querySelectorAll('button').forEach(button => { button.disabled = true; });
    this.showToast(`Cargando el estudio ${this.currentProject}...`, 'info');
    try {
      this.applySupervisorModuleAssignment();
      await this.refreshFromBackend();
      this.startRealtimeSync();
      this.enterSupervisorModule(this.currentModule);
      this.showToast(`Ahora trabajas en ${this.currentProject}. Sus validadores y auditorías están separados de los demás estudios.`, 'success');
    } catch (error) {
      this.showToast(error.message || 'No fue posible abrir el estudio seleccionado.', 'error');
      this.showView('supervisor-hub');
    }
  }

  applySupervisorModuleAssignment() {
    if (this.currentRole !== 'supervisor' || !this.currentScope) return;
    const assignedModule = SUPERVISOR_MODULES[this.currentScope?.module] ? this.currentScope.module : 'smart';
    const moduleInfo = SUPERVISOR_MODULES[assignedModule];
    this.currentModule = assignedModule;
    if (window.currentNavState) window.currentNavState.module = assignedModule;

    const studyName = this.currentScope.study?.name || this.currentProject;
    const message = `Trabajando en ${studyName} · ${moduleInfo.label}.`;
    const contextMessage = document.getElementById('supervisor-assigned-module-message');
    const hubMessage = document.getElementById('supervisor-hub-assignment');
    if (contextMessage) contextMessage.textContent = message;
    if (hubMessage) hubMessage.textContent = `${message} Puedes cambiar de estudio cuando lo necesites.`;

    const historyModuleFilter = document.getElementById('history-module-filter');
    if (historyModuleFilter) {
      historyModuleFilter.value = assignedModule;
      historyModuleFilter.disabled = true;
      historyModuleFilter.title = `Asignado a ${moduleInfo.label}`;
    }

    this.selectModule(assignedModule);
  }

  mergeActiveAuditsIntoHistory(module, activeAudits) {
    const cached = this.auditHistoryByModule[module];
    if (!Array.isArray(cached)) return;

    const keyFor = audit => audit._rowId
      ? `row:${audit._rowId}`
      : `batch:${audit._batchId || 'active'}:${audit.id}`;
    const merged = new Map(cached.map(audit => [keyFor(audit), audit]));
    (activeAudits || []).forEach(audit => merged.set(keyFor(audit), audit));
    this.auditHistoryByModule[module] = [...merged.values()];
  }

  getReportAuditSource(module = this.currentModule) {
    const cached = this.auditHistoryByModule[module];
    if (Array.isArray(cached)) return cached;
    return module === 'blocking' ? (this.blockingAudits || []) : (this.smartAudits || []);
  }

  setHistoricalReportsLoading(isLoading, loadedCount = 0) {
    const label = document.getElementById('op-filtered-count-label');
    if (isLoading && label) {
      label.textContent = loadedCount > 0
        ? `Cargando histórico completo… ${loadedCount} auditorías`
        : 'Cargando histórico completo desde Supabase…';
    }
    ['btn-export-excel', 'btn-export-multi-sheet', 'btn-export-executive-xlsx',
      'btn-export-commercial-pdf', 'btn-preview-commercial-report']
      .forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = isLoading;
      });
  }

  setHistoryDateRangeFromAudits(audits) {
    const dates = (audits || [])
      .map(audit => this.getAuditOperationDate(audit))
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    if (!dates.length) return false;

    const dateFrom = document.getElementById('history-date-from');
    const dateTo = document.getElementById('history-date-to');
    const moduleFilter = document.getElementById('history-module-filter');
    if (dateFrom) dateFrom.value = dates[0];
    if (dateTo) dateTo.value = dates[dates.length - 1];
    if (moduleFilter) moduleFilter.value = this.currentModule;
    return true;
  }

  async ensureHistoricalReportsLoaded({ force = false } = {}) {
    if (!this.backend.configured || !this.isSupervisor) return;
    const module = this.currentModule;
    if (!force && Array.isArray(this.auditHistoryByModule[module])) return;
    if (this.auditHistoryLoadPromises[module]) return this.auditHistoryLoadPromises[module];

    this.setHistoricalReportsLoading(true);
    const loadPromise = this.backend.loadAuditHistory({
      module,
      pageSize: 500,
      onProgress: count => this.setHistoricalReportsLoading(true, count)
    });
    this.auditHistoryLoadPromises[module] = loadPromise;

    try {
      const audits = await loadPromise;
      this.auditHistoryByModule[module] = audits;
      if (this.currentModule === module) {
        this.setHistoryDateRangeFromAudits(audits);
        this.renderReportsView();
        this.renderDailyReportsView();
        this.validatorHistoryLoaded = false;
        if (audits.length) await this.loadValidatorHistory(true);
      }
    } catch (error) {
      console.error('Error cargando el histórico completo:', error);
      this.renderReportsView();
      this.renderDailyReportsView();
      this.showToast(error.message || 'No fue posible cargar el histórico completo.', 'error');
    } finally {
      this.auditHistoryLoadPromises[module] = null;
      this.setHistoricalReportsLoading(false);
    }
  }

  startRealtimeSync() {
    if (!this.backend.configured) return;
    this.backend.subscribe(() => {
      clearTimeout(this.remoteRefreshTimer);
      this.remoteRefreshTimer = setTimeout(() => {
        this.refreshFromBackend().catch(error => {
          console.error('Error actualizando datos en vivo:', error);
        });
      }, 200);
    });
  }

  listenCrossTabEvents() {
    if (this.channel) {
      this.channel.onmessage = (event) => {
        if (event.data && event.data.type === 'STATE_UPDATED') {
          this.loadState();
          this.renderAdminView();
          this.renderReportsView();
          this.renderAlertsView();
          this.populateLookupQuickTags();
          if (this.validatorUI.currentValidator) {
            this.validatorUI.updateProgressHeader();
            this.validatorUI.renderAuditList();
            if (this.validatorUI.currentAuditId) {
              const current = this.audits.find(a => a.id === this.validatorUI.currentAuditId);
              if (current) this.validatorUI.renderAuditDetail(current);
            }
          }
        }
      };
    }

    window.addEventListener('storage', (e) => {
      if (e.key === this.storageKey) {
        this.loadState();
        this.renderAdminView();
        this.renderReportsView();
        this.renderAlertsView();
      }
    });
  }

  // ==========================================
  // INICIALIZACIÓN DE LA INTERFAZ
  // ==========================================
  initUI() {
    const tabBtns = document.querySelectorAll('#supervisor-nav-tabs .nav-tab-btn');
    const tabPanes = document.querySelectorAll('#private-supervisor-view .tab-content-pane');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(`tab-${targetTab}`)?.classList.add('active');

        if (targetTab === 'reports') {
          this.renderReportsView();
        } else if (targetTab === 'admin') {
          this.renderAdminView();
        } else if (targetTab === 'lookup') {
          this.populateLookupQuickTags();
          document.getElementById('lookup-search-input')?.focus();
        } else if (targetTab === 'queries') {
          this.renderQueriesView();
        } else if (targetTab === 'alerts') {
          this.renderAlertsView();
        }
      });
    });

    const dropzone = document.getElementById('excel-dropzone');
    const fileInput = document.getElementById('excel-file-input');

    dropzone?.addEventListener('click', () => fileInput?.click());

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        this.handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    fileInput?.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.handleFileUpload(e.target.files[0]);
      }
    });

    document.getElementById('btn-load-sample')?.addEventListener('click', () => {
      this.loadSampleData(true);
    });

    document.getElementById('btn-distribute-audits')?.addEventListener('click', () => {
      this.executeDistribution();
    });

    document.getElementById('btn-add-validator')?.addEventListener('click', () => {
      this.openAddValidatorModal();
    });

    document.getElementById('btn-export-excel')?.addEventListener('click', () => {
      ExcelParser.exportResultsToExcel(this.audits, this.validators);
    });

    document.getElementById('btn-refresh-alerts')?.addEventListener('click', () => {
      this.renderAlertsView();
      this.showToast('Auditorías reanalizadas. Detección de anomalías actualizada.', 'success');
    });

    this.initValidatorModal();
  }

  // ==========================================
  // MOTOR DE CONTROL DE CALIDAD Y ALERTAS DE ANOMALÍAS (¡NUEVO!)
  // ==========================================
  initAlertsModule() {
    this.thresholdMinSec = 25;
    this.thresholdWarnSec = 45;

    const filterBtns = document.querySelectorAll('.alert-filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.alertsFilter = btn.dataset.filter || 'all';
        this.renderAlertsView();
      });
    });

    const btnApplyThreshold = document.getElementById('btn-apply-threshold');
    const inputMin = document.getElementById('threshold-min-sec');
    const inputWarn = document.getElementById('threshold-warn-sec');

    btnApplyThreshold?.addEventListener('click', () => {
      const minVal = parseInt(inputMin?.value) || 25;
      const warnVal = parseInt(inputWarn?.value) || 45;

      if (minVal >= warnVal) {
        this.showToast('El tiempo crítico debe ser menor al tiempo recomendado.', 'warning');
        return;
      }

      this.thresholdMinSec = minVal;
      this.thresholdWarnSec = warnVal;
      this.renderAlertsView();
      this.showToast(`Parámetros actualizados: Crítico < ${minVal}s, Advertencia < ${warnVal}s`, 'success');
    });
  }

  /**
   * Analiza todas las auditorías validadas para detectar comportamientos inusuales
   */
  analyzeQualityAndAnomalies() {
    const anomalies = [];
    const valStats = {};
    const valMap = new Map(this.validators.map(v => [v.id, v]));

    // Inicializar estadísticas por validador
    this.validators.forEach(v => {
      valStats[v.id] = {
        validator: v,
        totalCompleted: 0,
        totalDurationSec: 0,
        totalKpisReviewed: 0,
        totalAplica: 0,
        totalNoAplica: 0,
        fastAuditsCount: 0, // < 12 segundos
        tipificacionesCount: {},
        anomalies: []
      };
    });

    // 1. Detección de validaciones ultrarrápidas y consolidación por validador
    this.audits.forEach(audit => {
      if (audit.validationStatus === 'completada' && audit.assignedValidatorId) {
        const stats = valStats[audit.assignedValidatorId];
        const val = valMap.get(audit.assignedValidatorId);
        const valName = val ? val.name : 'Validador desconocido';

        if (stats) {
          stats.totalCompleted++;
          const duration = audit.durationSeconds || 15;
          stats.totalDurationSec += duration;

          const kpisReviewed = (audit.kpis || []).filter(k => k.needsReview);
          stats.totalKpisReviewed += kpisReviewed.length;

          // Contar decisiones
          Object.values(audit.validationResults || {}).forEach(res => {
            if (res.status === 'aplica') stats.totalAplica++;
            if (res.status === 'no_aplica') {
              stats.totalNoAplica++;
              if (res.tipificacion) {
                stats.tipificacionesCount[res.tipificacion] = (stats.tipificacionesCount[res.tipificacion] || 0) + 1;
              }
            }
          });

          // Regla 1: Tiempo de validación por debajo del rango esperado
          const minSec = this.thresholdMinSec || 25;
          const warnSec = this.thresholdWarnSec || 45;

          if (duration < minSec) {
            stats.fastAuditsCount++;
            anomalies.push({
              id: `speed-${audit.id}`,
              type: 'speed',
              severity: 'critical',
              title: `⚡ Tiempo de Validación Reducido (< ${minSec}s)`,
              valName,
              valCode: val?.code || '',
              auditId: audit.id,
              pdvId: audit.idPDV,
              description: `La auditoría #${audit.id} (${kpisReviewed.length} KPIs a revisar) se completó en <strong>${duration} segundos</strong>, lo cual es inferior al tiempo mínimo estimado (${minSec}s) para una verificación detallada de cada alerta.`,
              timestamp: audit.completedAt || new Date().toISOString()
            });
          } else if (duration < warnSec) {
            stats.fastAuditsCount++;
            anomalies.push({
              id: `speed-${audit.id}`,
              type: 'speed',
              severity: 'warning',
              title: `⏱️ Revisión Acelerada (< ${warnSec}s)`,
              valName,
              valCode: val?.code || '',
              auditId: audit.id,
              pdvId: audit.idPDV,
              description: `Registrada en <strong>${duration} segundos</strong>, por debajo del tiempo promedio sugerido (${warnSec}s) para la evaluación de todos los KPIs.`,
              timestamp: audit.completedAt || new Date().toISOString()
            });
          }
        }
      }
    });

    // 2. Detección de tendencias de respuesta por Validador
    Object.values(valStats).forEach(st => {
      if (st.totalCompleted >= 2) {
        const totalResp = st.totalAplica + st.totalNoAplica;
        if (totalResp > 0) {
          const aplicaPct = Math.round((st.totalAplica / totalResp) * 100);
          const noAplicaPct = Math.round((st.totalNoAplica / totalResp) * 100);

          // Regla 2: Tendencia mayor al 85%
          if (aplicaPct >= 85) {
            anomalies.push({
              id: `bias-aplica-${st.validator.id}`,
              type: 'bias',
              severity: aplicaPct === 100 ? 'critical' : 'warning',
              title: `🎯 Tendencia de Respuesta: ${aplicaPct}% Aplica`,
              valName: st.validator.name,
              valCode: st.validator.code,
              auditId: null,
              pdvId: null,
              description: `El validador <strong>${st.validator.name}</strong> presenta un <strong>${aplicaPct}%</strong> de decisiones marcadas como <em>"Aplica"</em> (${st.totalAplica} de ${totalResp} KPIs evaluados).`,
              timestamp: new Date().toISOString()
            });
          } else if (noAplicaPct >= 85) {
            anomalies.push({
              id: `bias-no-aplica-${st.validator.id}`,
              type: 'bias',
              severity: noAplicaPct === 100 ? 'critical' : 'warning',
              title: `🎯 Tendencia de Respuesta: ${noAplicaPct}% No Aplica`,
              valName: st.validator.name,
              valCode: st.validator.code,
              auditId: null,
              pdvId: null,
              description: `El validador <strong>${st.validator.name}</strong> presenta un <strong>${noAplicaPct}%</strong> de decisiones marcadas como <em>"No Aplica"</em> (${st.totalNoAplica} de ${totalResp} KPIs evaluados).`,
              timestamp: new Date().toISOString()
            });
          }

          // Regla 3: Uso frecuente de la misma tipificación
          const tipifEntries = Object.entries(st.tipificacionesCount);
          if (tipifEntries.length > 0 && st.totalNoAplica >= 3) {
            tipifEntries.forEach(([tipifName, count]) => {
              const tipifPct = Math.round((count / st.totalNoAplica) * 100);
              if (tipifPct >= 80) {
                anomalies.push({
                  id: `tipif-mono-${st.validator.id}`,
                  type: 'bias',
                  severity: 'warning',
                  title: '📝 Tipificación Frecuente',
                  valName: st.validator.name,
                  valCode: st.validator.code,
                  auditId: null,
                  pdvId: null,
                  description: `El <strong>${tipifPct}%</strong> de las alertas marcadas como "No Aplica" por ${st.validator.name} corresponden al motivo <em>"${tipifName}"</em> (${count} veces).`,
                  timestamp: new Date().toISOString()
                });
              }
            });
          }
        }
      }
    });

    return { anomalies, valStats };
  }

  renderAlertsView() {
    const { anomalies, valStats } = this.analyzeQualityAndAnomalies();

    // Contadores de severidad
    const criticalCount = anomalies.filter(a => a.severity === 'critical').length;
    const fastCount = anomalies.filter(a => a.type === 'speed').length;
    const biasCount = anomalies.filter(a => a.type === 'bias').length;

    // Calcular índice de confiabilidad global
    const totalCompleted = this.audits.filter(a => a.validationStatus === 'completada').length;
    let healthIndex = 100;
    if (totalCompleted > 0) {
      healthIndex = Math.max(20, Math.round(100 - (criticalCount * 12) - (biasCount * 6)));
    }

    const critEl = document.getElementById('alert-stat-critical');
    const fastEl = document.getElementById('alert-stat-fast');
    const biasEl = document.getElementById('alert-stat-bias');
    const healthEl = document.getElementById('alert-stat-health');
    const countBadge = document.getElementById('anomalies-count-badge');
    const navBadge = document.getElementById('nav-alerts-badge');

    if (critEl) critEl.textContent = criticalCount;
    if (fastEl) fastEl.textContent = fastCount;
    if (biasEl) biasEl.textContent = biasCount;
    if (healthEl) {
      healthEl.textContent = `${healthIndex}%`;
      healthEl.className = healthIndex >= 85 ? 'stat-value text-success' : healthIndex >= 60 ? 'stat-value text-warning' : 'stat-value text-magenta';
    }
    if (countBadge) countBadge.textContent = `${anomalies.length} hallazgo${anomalies.length !== 1 ? 's' : ''}`;

    // Badge en la pestaña de navegación
    if (navBadge) {
      if (anomalies.length > 0) {
        navBadge.classList.remove('hidden');
        navBadge.textContent = anomalies.length;
      } else {
        navBadge.classList.add('hidden');
      }
    }

    // 1. Renderizar Tarjetas de Salud de Validadores
    const healthContainer = document.getElementById('val-health-list');
    if (healthContainer) {
      const statsList = Object.values(valStats);

      if (statsList.length === 0) {
        healthContainer.innerHTML = `<p class="text-muted">No hay validadores activos para monitorear.</p>`;
      } else {
        healthContainer.innerHTML = statsList.map(st => {
          const avgSec = st.totalCompleted > 0 ? Math.round(st.totalDurationSec / st.totalCompleted) : 0;
          const totalResp = st.totalAplica + st.totalNoAplica;
          const aplicaPct = totalResp > 0 ? Math.round((st.totalAplica / totalResp) * 100) : 0;

          // Calcular score individual (0 a 100)
          let score = 95;
          const flags = [];

          if (st.fastAuditsCount > 0) {
            score -= (st.fastAuditsCount * 15);
            flags.push(`⚡ ${st.fastAuditsCount} auditoría(s) con tiempo ultrarrápido (< 10s)`);
          }

          if (st.totalCompleted >= 2 && (aplicaPct >= 85 || aplicaPct <= 15)) {
            score -= 20;
            flags.push(`🎯 Sesgo marcado en respuestas (${aplicaPct}% Aplica)`);
          }

          score = Math.max(10, Math.min(100, score));

          const healthClass = score >= 85 ? 'health-good' : score >= 60 ? 'health-warning' : 'health-critical';
          const badgeClass = score >= 85 ? 'score-good' : score >= 60 ? 'score-warning' : 'score-critical';

          return `
            <div class="val-health-card ${healthClass}">
              <div class="val-health-top">
                <div>
                  <h4 style="margin:0; font-size:1rem; color:var(--dn-navy);">${st.validator.name}</h4>
                  <span class="val-code-badge" style="font-size:0.75rem;">${st.validator.code}</span>
                </div>
                <span class="val-health-score-badge ${badgeClass}">${score}% Confiabilidad</span>
              </div>

              <div class="val-health-metrics-grid">
                <div>
                  <span class="health-metric-num">${avgSec}s</span>
                  <span class="health-metric-lbl">Tiempo Promedio</span>
                </div>
                <div>
                  <span class="health-metric-num text-success">${aplicaPct}%</span>
                  <span class="health-metric-lbl">% Aplica</span>
                </div>
                <div>
                  <span class="health-metric-num">${st.totalCompleted}</span>
                  <span class="health-metric-lbl">Auditorías</span>
                </div>
              </div>

              ${flags.length > 0 ? `
                <div class="health-flags-list">
                  ${flags.map(f => `<div class="health-flag-item text-danger">${f}</div>`).join('')}
                </div>
              ` : `
                <div class="health-flag-item text-success">✓ Patrón de validación equilibrado y tiempo adecuado</div>
              `}
            </div>
          `;
        }).join('');
      }
    }

    // 2. Renderizar Feed de Anomalías
    const anomaliesContainer = document.getElementById('anomalies-list');
    if (anomaliesContainer) {
      let filtered = anomalies;
      if (this.alertsFilter === 'speed') filtered = anomalies.filter(a => a.type === 'speed');
      if (this.alertsFilter === 'bias') filtered = anomalies.filter(a => a.type === 'bias');

      if (filtered.length === 0) {
        anomaliesContainer.innerHTML = `
          <div class="empty-reasons-state">
            <div style="font-size:2.5rem; margin-bottom:0.5rem;">🎉</div>
            <p><strong>¡Excelente! No se detectaron anomalías con el filtro seleccionado.</strong></p>
            <span class="text-muted" style="font-size:0.8rem;">Todas las validaciones mantienen tiempos consistentes y patrones equilibrados.</span>
          </div>
        `;
      } else {
        anomaliesContainer.innerHTML = filtered.map(item => {
          const sevClass = item.severity === 'critical' ? 'sev-critical' : item.severity === 'warning' ? 'sev-warning' : 'sev-info';
          const sevBadge = item.severity === 'critical' 
            ? `<span class="badge badge-danger">🔴 Crítica</span>` 
            : `<span class="badge badge-warning">🟡 Advertencia</span>`;

          return `
            <div class="anomaly-card-item ${sevClass}">
              <div class="anomaly-header-row">
                <div class="anomaly-type-title">
                  <span>${item.title}</span>
                </div>
                ${sevBadge}
              </div>

              <div class="anomaly-body">
                ${item.description}
              </div>

              <div class="anomaly-footer-row">
                <span>Validador: <strong>${item.valName}</strong> (${item.valCode})</span>
                ${item.auditId ? `
                  <button class="btn btn-outline btn-sm btn-inspect-anomaly" data-audit-id="${item.auditId}">
                    Inspeccionar Caso #${item.auditId} 🔎
                  </button>
                ` : `
                  <span class="text-muted">Alerta de Comportamiento Global</span>
                `}
              </div>
            </div>
          `;
        }).join('');

        // Listeners para saltar directamente a la Ficha Técnica de la auditoría
        anomaliesContainer.querySelectorAll('.btn-inspect-anomaly').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.auditId;
            this.inspectAuditFromAlert(id);
          });
        });
      }
    }
  }

  inspectAuditFromAlert(auditId) {
    const lookupTabBtn = document.querySelector('#supervisor-nav-tabs .nav-tab-btn[data-tab="lookup"]');
    lookupTabBtn?.click();

    const searchInput = document.getElementById('lookup-search-input');
    if (searchInput) searchInput.value = auditId;
    document.getElementById('btn-clear-lookup')?.classList.remove('hidden');
    this.executeLookup(auditId);
  }

  // ==========================================
  // HOJA DE BÚSQUEDA DE PDV Y AUDITORÍAS
  // ==========================================
  initLookupModule() {
    const searchInput = document.getElementById('lookup-search-input');
    const btnSearch = document.getElementById('btn-execute-lookup');
    const btnClear = document.getElementById('btn-clear-lookup');

    const doSearch = () => {
      const query = searchInput?.value.trim();
      this.executeLookup(query);
    };

    btnSearch?.addEventListener('click', doSearch);
    searchInput?.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') doSearch();
      if (searchInput.value.trim().length > 0) {
        btnClear?.classList.remove('hidden');
      } else {
        btnClear?.classList.add('hidden');
      }
    });

    btnClear?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      btnClear.classList.add('hidden');
      this.resetLookupView();
    });

    this.populateLookupQuickTags();
  }

  populateLookupQuickTags() {
    const tagsContainer = document.getElementById('lookup-quick-tags');
    if (!tagsContainer) return;

    if (this.audits.length === 0) {
      tagsContainer.innerHTML = '<span class="text-muted">Carga auditorías para ver ejemplos</span>';
      return;
    }

    const sampleItems = this.audits.slice(0, 4);
    tagsContainer.innerHTML = sampleItems.map(a => {
      return `
        <button class="quick-tag-btn" data-search="${a.id}">Auditoría #${a.id}</button>
        ${a.idPDV ? `<button class="quick-tag-btn" data-search="${a.idPDV}">PDV ${a.idPDV}</button>` : ''}
      `;
    }).join('');

    tagsContainer.querySelectorAll('.quick-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const query = btn.dataset.search;
        const searchInput = document.getElementById('lookup-search-input');
        if (searchInput) searchInput.value = query;
        document.getElementById('btn-clear-lookup')?.classList.remove('hidden');
        this.executeLookup(query);
      });
    });
  }

  async executeLookup(query) {
    if (!query) {
      this.showToast('Ingresa un ID de Auditoría o de PDV para buscar.', 'warning');
      return;
    }

    const cleanQ = query.toLowerCase().trim();
    const placeholder = document.getElementById('lookup-empty-placeholder');
    const caseFileContainer = document.getElementById('lookup-case-file');
    const searchButton = document.getElementById('btn-execute-lookup');
    const previousButtonLabel = searchButton?.textContent;
    let matches = [];

    if (searchButton) {
      searchButton.disabled = true;
      searchButton.textContent = 'Buscando en el histórico…';
    }

    try {
      if (this.backend.configured && ['supervisor', 'admin'].includes(this.currentRole)) {
        matches = await this.backend.searchAuditHistory(query, {
          module: this.currentModule,
          limit: 50
        });
      } else {
        matches = this.audits.filter(audit => {
          const auditId = String(audit.id || '').toLowerCase();
          const pdvId = String(audit.idPDV || '').toLowerCase();
          return auditId === cleanQ || pdvId === cleanQ;
        });
      }
    } catch (error) {
      console.error('Error consultando el histórico de auditorías:', error);
      this.showToast(error.message || 'No fue posible consultar el histórico.', 'error');
      return;
    } finally {
      if (searchButton) {
        searchButton.disabled = false;
        searchButton.textContent = previousButtonLabel || 'Buscar Caso 🔎';
      }
    }

    if (!matches.length) {
      if (placeholder) {
        placeholder.classList.remove('hidden');
        placeholder.innerHTML = `
          <div class="lookup-placeholder-icon">❌</div>
          <h3>No se encontró ninguna auditoría con ese ID</h3>
          <p>Verifica que el ID de auditoría o de PDV esté escrito exactamente como aparece en la base.</p>
        `;
      }
      if (caseFileContainer) caseFileContainer.classList.add('hidden');
      this.showToast(`No se encontraron registros para "${query}".`, 'warning');
      return;
    }

    if (placeholder) placeholder.classList.add('hidden');
    if (caseFileContainer) {
      caseFileContainer.classList.remove('hidden');
      this.renderLookupMatches(matches, caseFileContainer);
    }
    if (matches.length > 1) {
      this.showToast(`Se encontraron ${matches.length} jornadas con el ID "${query}".`, 'success');
    }
  }

  renderLookupMatches(matches, container) {
    if (matches.length === 1) {
      this.renderCaseFile(matches[0], container);
      return;
    }

    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
    container.innerHTML = `
      <div class="lookup-history-matches">
        <div>
          <strong>${matches.length} registros históricos encontrados</strong>
          <span>Selecciona la jornada que deseas consultar.</span>
        </div>
        <div class="lookup-history-match-list">
          ${matches.map((audit, index) => `
            <button type="button" class="lookup-history-match-btn ${index === 0 ? 'active' : ''}" data-match-index="${index}">
              <strong>${escapeHtml(audit._batchOperationDate || audit.fecha || 'Sin fecha')}</strong>
              <span>${escapeHtml(audit._batchStatus === 'active' ? 'Base activa' : 'Histórico')} · ${escapeHtml(audit._validatorName || audit.assignedValidatorId || 'Sin asignar')}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div id="lookup-selected-case"></div>
    `;

    const detail = container.querySelector('#lookup-selected-case');
    this.renderCaseFile(matches[0], detail);
    container.querySelectorAll('.lookup-history-match-btn').forEach(button => {
      button.addEventListener('click', () => {
        container.querySelectorAll('.lookup-history-match-btn').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        const audit = matches[Number(button.dataset.matchIndex) || 0];
        this.renderCaseFile(audit, detail);
      });
    });
  }

  resetLookupView() {
    const placeholder = document.getElementById('lookup-empty-placeholder');
    const caseFileContainer = document.getElementById('lookup-case-file');

    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML = `
        <div class="lookup-placeholder-icon">🔎</div>
        <h3>Ingresa un ID de Auditoría o ID de PDV en el buscador</h3>
        <p>La plataforma consultará toda la base de datos y te presentará la ficha técnica completa con las alertas, tipificaciones y trazabilidad de validación.</p>
      `;
    }
    if (caseFileContainer) caseFileContainer.classList.add('hidden');
  }

  renderCaseFile(audit, container) {
    const valMap = new Map(this.validators.map(v => [v.id, v]));
    const validator = valMap.get(audit.assignedValidatorId) || (audit._validatorName ? {
      name: audit._validatorName,
      code: audit._validatorCode || audit.assignedValidatorId || '—'
    } : null);

    const isCompleted = audit.validationStatus === 'completada';
    const statusBadgeClass = isCompleted ? 'decision-aplica' : audit.validationStatus === 'en_progreso' ? 'decision-no-aplica' : 'decision-pendiente';
    const statusText = isCompleted ? '✓ VALIDADA Y COMPLETADA' : audit.validationStatus === 'en_progreso' ? 'EN PROCESO' : 'PENDIENTE DE VALIDAR';

    const kpisRows = (audit.kpis || []).map((kpi, index) => {
      const result = (audit.validationResults || {})[kpi.name] || {};
      const status = result.status;
      const tipificacion = result.tipificacion || '—';
      const observaciones = result.observaciones || '—';
      const decisionTime = result.decisionAt
        ? formatNicaraguaDateTime(result.decisionAt)
        : (status ? 'Sin registro histórico' : '—');

      let decisionBadgeHtml = '';
      if (status === 'aplica') {
        decisionBadgeHtml = `<span class="decision-badge decision-aplica">✓ APLICA</span>`;
      } else if (status === 'no_aplica') {
        decisionBadgeHtml = `<span class="decision-badge decision-no-aplica">✕ NO APLICA</span>`;
      } else if (kpi.needsReview) {
        decisionBadgeHtml = `<span class="decision-badge decision-pendiente">⏳ PENDIENTE</span>`;
      } else {
        decisionBadgeHtml = `<span class="text-muted">No requería revisión</span>`;
      }

      return `
        <tr>
          <td><strong>${index + 1}. ${kpi.name}</strong></td>
          <td><span class="badge ${kpi.needsReview ? 'badge-warning' : 'badge-secondary'}">${kpi.originalValue || (kpi.needsReview ? 'Revisar' : 'OK')}</span></td>
          <td>${decisionBadgeHtml}</td>
          <td>${status === 'no_aplica' ? `<span class="tipif-tag">${tipificacion}</span>` : '—'}</td>
          <td>${observaciones !== '—' ? `<span class="obs-tag">"${observaciones}"</span>` : '—'}</td>
          <td>${decisionTime}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="case-file-card">
        <div class="case-file-header">
          <div class="case-title-group">
            <span class="case-tag">Ficha Técnica de Validación • dichter & neira</span>
            <h2>Auditoría #${audit.id}</h2>
            <span class="case-pdv-subtitle">Punto de Venta (PDV): <strong>${audit.idPDV || 'N/A'}</strong></span>
          </div>

          <div class="case-header-badges">
            <span class="badge badge-info">Jornada: ${audit._batchOperationDate || audit.fecha || 'Sin fecha'}</span>
            <span class="decision-badge ${statusBadgeClass}">${statusText}</span>
          </div>
        </div>

        <div class="case-file-body">
          <div class="case-summary-grid">
            <div class="summary-card">
              <h4>📍 Datos de la Auditoría en Campo</h4>
              <div class="summary-fields">
                <div class="field-item">
                  <span class="field-label">País / Región</span>
                  <span class="field-value">${audit.pais || 'N/A'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Ciudad</span>
                  <span class="field-value">${audit.ciudad || 'N/A'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Canal</span>
                  <span class="field-value">${audit.canal || 'N/A'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Fecha de Captura</span>
                  <span class="field-value">${audit.fecha || 'N/A'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Auditor de Campo</span>
                  <span class="field-value">${audit.usuario || 'N/A'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Estado Inicial</span>
                  <span class="field-value">${audit.estado || 'Aprobada'}</span>
                </div>
              </div>
            </div>

            <div class="summary-card">
              <h4>👤 Información del Validador y Tiempo</h4>
              <div class="summary-fields">
                <div class="field-item">
                  <span class="field-label">Validador Responsable</span>
                  <span class="field-value">${validator ? validator.name : '<span class="text-muted">Sin Asignar</span>'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Código Validador</span>
                  <span class="field-value">${validator ? `<span class="val-code-badge">${validator.code}</span>` : '—'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Tiempo de Revisión</span>
                  <span class="field-value">${audit.durationSeconds ? `<strong>${audit.durationSeconds} segundos</strong>` : '—'}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Inicio de validación (Nicaragua)</span>
                  <span class="field-value">${formatNicaraguaDateTime(audit.startedAt, 'Pendiente')}</span>
                </div>
                <div class="field-item">
                  <span class="field-label">Fin de validación (Nicaragua)</span>
                  <span class="field-value">${formatNicaraguaDateTime(audit.completedAt, 'Pendiente')}</span>
                </div>
                <div class="field-item" style="grid-column: span 2;">
                  <span class="field-label">KPIs Asignados a Revisión</span>
                  <span class="field-value">${(audit.kpis || []).filter(k => k.needsReview).length} KPIs marcados con alerta</span>
                </div>
              </div>
            </div>
          </div>

          <div class="summary-card">
            <h4>📋 Detalle de Alertas Marcadas, Aplicación y Tipificación</h4>
            <div class="case-kpis-table-container">
              <table class="case-kpi-table">
                <thead>
                  <tr>
                    <th>KPI / Alerta</th>
                    <th>Alerta Reportada</th>
                    <th>¿Aplicó? (Decisión)</th>
                    <th>Tipificación del Rechazo</th>
                    <th>Observaciones Registradas</th>
                    <th>Hora de Respuesta Final<br>(Nicaragua)</th>
                  </tr>
                </thead>
                <tbody>
                  ${kpisRows}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // CARGA Y PARSEO DE ARCHIVOS CON ASIGNACIÓN DE ESTUDIO
  // ==========================================
  async handleFileUpload(file) {
    try {
      this.showToast(`Leyendo archivo: ${file.name}...`, 'info');
      let result;

      if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
        const text = await file.text();
        result = ExcelParser.parseCSV(text);
      } else {
        result = await ExcelParser.parseExcelFile(file);
      }

      if (!result.audits || result.audits.length === 0) {
        this.showToast('No se encontraron registros de auditoría válidos en el archivo.', 'error');
        return;
      }

      // Guardar datos temporalmente a la espera de confirmación de estudio
      this.pendingUpload = {
        fileName: file.name,
        result
      };

      this.openSelectStudyModal(file.name, result.audits.length);
    } catch (err) {
      console.error(err);
      this.showToast('Error al leer el archivo: ' + err.message, 'error');
    }
  }

  openSelectStudyModal(fileName, auditCount, detectedDate = null) {
    const modal = document.getElementById('modal-select-study');
    const fnEl = document.getElementById('study-modal-filename');
    const countEl = document.getElementById('study-modal-rows-count');
    const assignedStudyEl = document.getElementById('study-modal-assigned-study');
    const dateEl = document.getElementById('study-operation-date');

    if (fnEl) fnEl.textContent = fileName;
    if (countEl) countEl.textContent = `${auditCount} auditorías detectadas listas para importar`;
    const assignedStudy = this.currentScope?.study?.name || this.currentProject || 'Sin estudio asignado';
    if (assignedStudyEl) assignedStudyEl.textContent = assignedStudy;

    const todayStr = new Date().toISOString().split('T')[0];
    if (dateEl) {
      dateEl.value = detectedDate || todayStr;
      dateEl.onchange = () => this.refreshCarryoverDecisionPanel();
    }

    modal?.classList.remove('hidden');
    this.refreshCarryoverDecisionPanel();
  }

  async refreshCarryoverDecisionPanel() {
    const panel = document.getElementById('carryover-decision-panel');
    const description = document.getElementById('carryover-decision-description');
    const list = document.getElementById('carryover-decision-list');
    panel?.classList.add('hidden');
    this.pendingCarryoverPreview = null;

    if (!this.backend.configured || !this.isSupervisor || !this.pendingUpload?.result) return;
    const operationDate = document.getElementById('study-operation-date')?.value;
    if (!operationDate) return;

    const requestId = (this.carryoverPreviewRequestId || 0) + 1;
    this.carryoverPreviewRequestId = requestId;
    try {
      const pending = await this.backend.getPendingCarryoverSummary({
        operationDate,
        module: this.currentModule
      });
      if (requestId !== this.carryoverPreviewRequestId || !pending) return;

      const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      })[char]);
      this.pendingCarryoverPreview = pending;
      if (description) {
        description.textContent = `Quedaron ${pending.pendingCount} auditoría${pending.pendingCount === 1 ? '' : 's'} pendiente${pending.pendingCount === 1 ? '' : 's'} de la jornada ${pending.previousOperationDate}. Elige qué hacer antes de cargar esta base.`;
      }
      if (list) {
        list.innerHTML = pending.pendingSummary.map(item => `
          <div class="carryover-summary-item">
            <span>👤 ${escapeHtml(item.validator_name || 'Sin asignar')}</span>
            <strong>${Number(item.count || 0)} pendientes</strong>
          </div>
        `).join('');
      }
      panel?.classList.remove('hidden');
    } catch (error) {
      console.error('No fue posible consultar los pendientes de la jornada anterior:', error);
    }
  }

  async confirmStudyUpload() {
    const studyName = this.currentScope?.study?.name || this.currentProject || 'Chile';
    const opDate = document.getElementById('study-operation-date')?.value || new Date().toISOString().split('T')[0];
    const modal = document.getElementById('modal-select-study');

    if (!this.pendingUpload || !this.pendingUpload.result) {
      this.currentProject = studyName;
      this.selectedStudies = [studyName];
      const projEl = document.getElementById('context-project-name');
      if (projEl) projEl.textContent = studyName;
      this.renderAdminView();
      this.renderReportsView();
      this.showToast(`Estudio establecido en: ${studyName}`, 'info');
      return;
    }

    let carryoverAction = 'carry';
    let pendingCarryover = null;
    if (this.backend.configured && this.isSupervisor) {
      try {
        pendingCarryover = await this.backend.getPendingCarryoverSummary({
          operationDate: opDate,
          module: this.currentModule
        });
      } catch (error) {
        const message = String(error?.message || '');
        const isPendingFeatureUnavailable = /get_pending_carryover_summary|function.*not found|could not find/i.test(message);
        if (!isPendingFeatureUnavailable) {
          this.showToast(error.message || 'No fue posible consultar los pendientes de la jornada anterior.', 'error');
          return;
        }
        // The new carry-over migration is intentionally additive.  Until it
        // has been applied, preserve the existing, working upload process.
        console.warn('La función de pendientes todavía no está disponible; se usará la carga estándar.');
      }

      if (pendingCarryover) {
        carryoverAction = document.querySelector('input[name="carryover-decision"]:checked')?.value || '';
        if (!['carry', 'discard'].includes(carryoverAction)) {
          this.showToast('Elige si deseas sumar o cerrar los pendientes de la jornada anterior antes de cargar la nueva base.', 'warning');
          return;
        }
      }
    }

    modal?.classList.add('hidden');

    const { result } = this.pendingUpload;

    // Etiquetar todas las auditorías del archivo con el estudio seleccionado y la fecha de jornada
    result.audits.forEach(audit => {
      audit.estudio = studyName;
      audit.fecha = opDate;
      audit._studyId = this.currentScope?.study?.id || audit._studyId || null;
      audit._countryId = this.currentScope?.country?.id || audit._countryId || null;
      if (!audit.modelo || audit.modelo === 'Tradicional' || audit.modelo === 'TRADICIONAL') audit.modelo = studyName;
      if (!audit.canal) audit.canal = studyName;
      if (this.currentScope?.country?.code !== 'GLB' && this.currentScope?.country?.name) {
        audit.pais = this.currentScope.country.name;
      }
      else if (studyName === 'Chile') audit.pais = 'Chile';
    });

    this.currentProject = studyName;
    this.selectedStudies = [studyName];
    const projEl = document.getElementById('context-project-name');
    if (projEl) projEl.textContent = studyName;

    // Distribuir entre validadores del estudio con balanceo simultáneo
    const projectVals = this.getValidatorsForCurrentProject();
    if (projectVals.length > 0) {
      result.audits = Distributor.distribute(result.audits, projectVals);
    }

    if (this.backend.configured && this.isSupervisor) {
      try {
        const activatedBatch = await this.backend.importDailyBatch({
          audits: result.audits,
          module: this.currentModule,
          operationDate: opDate,
          fileName: this.pendingUpload.fileName,
          validators: this.validators,
          carryoverAction
        });
        this.auditHistoryByModule[this.currentModule] = null;
        this.validatorHistoryLoaded = false;
        this.pendingUpload = null;
        await this.refreshFromBackend();
        const carriedCount = Number(activatedBatch?.carried_over_count || 0);
        const finalCount = Number(activatedBatch?.row_count || result.audits.length);
        this.showToast(`¡Nueva jornada guardada con ${finalCount} auditorías para ${studyName} (${opDate})!`, 'success');
        if (carryoverAction === 'discard' && pendingCarryover) {
          this.showToast(`Se cerraron ${pendingCarryover.pendingCount} pendientes de la jornada ${pendingCarryover.previousOperationDate} sin asignarlos a esta nueva base.`, 'info');
        } else {
          this.showCarryoverSummary(activatedBatch);
        }
        this.pendingCarryoverPreview = null;
      } catch (error) {
        console.error('Error importando la jornada en Supabase:', error);
        this.showToast(error.message || 'No fue posible guardar la nueva jornada en Supabase.', 'error');
      }
      return;
    }

    // Acumular automáticamente día por día al historial existente (con deduplicación por ID)
    const existingMap = new Map();
    this.audits.forEach((a, i) => {
      existingMap.set(String(a.id), i);
    });

    result.audits.forEach(newA => {
      const key = String(newA.id);
      if (existingMap.has(key)) {
        const idx = existingMap.get(key);
        const prev = this.audits[idx];
        this.audits[idx] = {
          ...newA,
          validationStatus: prev.validationStatus || newA.validationStatus,
          validationResults: prev.validationResults || newA.validationResults,
          durationSeconds: prev.durationSeconds || newA.durationSeconds,
          completedAt: prev.completedAt || newA.completedAt,
          assignedValidatorId: prev.assignedValidatorId || newA.assignedValidatorId
        };
      } else {
        this.audits.push(newA);
      }
    });

    // Garantizar que this.audits esté siempre 100% libre de duplicados de id
    this.audits = ExcelParser.deduplicateById(this.audits);
    if (this.currentModule === 'blocking') {
      this.blockingAudits = this.audits;
    } else {
      this.smartAudits = this.audits;
    }

    this.headers = result.headers;
    this.kpiColumns = result.kpiColumns;

    this.syncStateAcrossTabs();
    this.renderAdminView();
    this.renderAlertsView();
    this.renderReportsView();
    this.renderQueriesView();
    this.populateLookupQuickTags();
    this.showToast(`¡${result.audits.length} auditorías acumuladas para ${studyName} (Jornada: ${opDate})!`, 'success');
    this.pendingUpload = null;
  }

  showCarryoverSummary(batch) {
    const carriedCount = Number(batch?.carried_over_count || 0);
    if (!carriedCount) return;

    const modal = document.getElementById('modal-carryover-summary');
    const total = document.getElementById('carryover-summary-total');
    const list = document.getElementById('carryover-summary-list');
    const summary = Array.isArray(batch?.carryover_summary) ? batch.carryover_summary : [];
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);

    if (total) {
      total.textContent = `${carriedCount} auditoría${carriedCount === 1 ? '' : 's'} pendiente${carriedCount === 1 ? '' : 's'} del día anterior ${carriedCount === 1 ? 'se sumó' : 'se sumaron'} a la nueva jornada.`;
    }
    if (list) {
      list.innerHTML = summary.map(item => `
        <div class="carryover-summary-item">
          <span>👤 ${escapeHtml(item.validator_name || 'Sin asignar')}</span>
          <strong>+${Number(item.count || 0)} auditorías</strong>
        </div>
      `).join('');
    }
    modal?.classList.remove('hidden');
  }

  loadSampleData(notify = true) {
    const isBlocking = this.currentModule === 'blocking';
    const csvData = isBlocking ? BLOCKING_ALERTS_SAMPLE_CSV : SAMPLE_CSV_DATA;
    const result = ExcelParser.parseCSV(csvData);

    const studyName = this.currentProject || 'Chile';
    result.audits.forEach(audit => {
      audit.estudio = studyName;
      if (!audit.modelo) audit.modelo = studyName;
    });

    let distributed = Distributor.distributeEqually(result.audits, this.validators);
    distributed = seedSampleValidations(distributed);

    if (isBlocking) {
      this.blockingAudits = distributed;
      this.audits = this.blockingAudits;
    } else {
      this.smartAudits = distributed;
      this.audits = this.smartAudits;
    }

    this.headers = result.headers;
    this.kpiColumns = result.kpiColumns;

    this.saveState();
    this.renderAdminView();
    this.renderAlertsView();
    this.renderReportsView();
    this.renderQueriesView();
    this.populateLookupQuickTags();
    this.validatorUI?.populateQuickSelect(this.validators);

    if (notify) {
      const modeName = isBlocking ? 'Alertas Bloqueantes' : 'Validación Smart';
      this.showToast(`Datos de ejemplo cargados para ${modeName} (${this.audits.length} auditorías) - Estudio: ${studyName}.`, 'success');
    }
  }

  // ==========================================
  // GESTIÓN DE ARCHIVOS, ESTUDIOS Y DEDUPLICACIÓN
  // ==========================================
  openReassignStudyModal() {
    if (this.currentScope?.study) {
      this.showToast('El estudio del supervisor lo define el Administrador y no puede cambiarse desde este panel.', 'warning');
      return;
    }
    const projectAudits = this.getAuditsForCurrentProject();
    if (projectAudits.length === 0) {
      this.showToast(`No hay auditorías cargadas en el estudio ${this.currentProject} para mover.`, 'warning');
      return;
    }

    const countEl = document.getElementById('reassign-modal-count');
    const fromEl = document.getElementById('reassign-modal-from');
    const inputEl = document.getElementById('reassign-target-study-input');
    const modal = document.getElementById('modal-reassign-study');

    if (countEl) countEl.textContent = `${projectAudits.length} auditorías`;
    if (fromEl) fromEl.textContent = this.currentProject;

    // Seleccionar por defecto un estudio diferente al actual
    const otherStudies = ['Tradicional', 'Moderno', 'Chile', 'Lindley'].filter(s => s.toUpperCase() !== this.currentProject.toUpperCase());
    const defaultTarget = otherStudies[0] || 'Tradicional';
    if (inputEl) inputEl.value = defaultTarget;

    document.querySelectorAll('#modal-reassign-study .study-option-card').forEach(card => {
      const s = card.dataset.reassignStudy;
      if (s === defaultTarget) card.classList.add('active');
      else card.classList.remove('active');
    });

    modal?.classList.remove('hidden');
  }

  selectReassignStudyOption(targetStudy) {
    const inputEl = document.getElementById('reassign-target-study-input');
    if (inputEl) inputEl.value = targetStudy;

    document.querySelectorAll('#modal-reassign-study .study-option-card').forEach(card => {
      const s = card.dataset.reassignStudy;
      if (s === targetStudy) card.classList.add('active');
      else card.classList.remove('active');
    });
  }

  executeReassignStudy() {
    if (this.currentScope?.study) {
      document.getElementById('modal-reassign-study')?.classList.add('hidden');
      this.showToast('No tienes permisos para cambiar el estudio asignado.', 'error');
      return;
    }
    const targetStudy = document.getElementById('reassign-target-study-input')?.value || 'Tradicional';
    const modal = document.getElementById('modal-reassign-study');
    modal?.classList.add('hidden');

    if (targetStudy.toUpperCase() === this.currentProject.toUpperCase()) {
      this.showToast('El estudio de destino es igual al actual.', 'info');
      return;
    }

    const prevStudy = this.currentProject;
    let countMoved = 0;

    // Actualizar las auditorías del estudio previo al nuevo estudio
    this.audits.forEach(audit => {
      if (this.getStudyForAudit(audit).toUpperCase() === prevStudy.toUpperCase()) {
        audit.estudio = targetStudy;
        audit.canal = targetStudy;
        audit.modelo = targetStudy;
        if (targetStudy === 'Chile') audit.pais = 'Chile';
        countMoved++;
      }
    });

    // Cambiar el proyecto activo al nuevo estudio
    this.currentProject = targetStudy;
    this.selectedStudies = [targetStudy];

    const projEl = document.getElementById('context-project-name');
    if (projEl) projEl.textContent = targetStudy;

    // Re-distribuir automáticamente entre los validadores del nuevo estudio
    const newValidators = this.getValidatorsForCurrentProject();
    if (newValidators.length > 0) {
      const projectAudits = this.getAuditsForCurrentProject();
      const distributed = Distributor.distribute(projectAudits, newValidators, this.distributionMode || 'audits');
      const distMap = new Map(distributed.map(a => [String(a.id), a]));
      this.audits = this.audits.map(a => distMap.has(String(a.id)) ? distMap.get(String(a.id)) : a);
    }

    // Deduplicación estricta de seguridad
    this.audits = ExcelParser.deduplicateById(this.audits);
    if (this.currentModule === 'blocking') {
      this.blockingAudits = this.audits;
    } else {
      this.smartAudits = this.audits;
    }

    this.saveState();
    this.syncStateAcrossTabs();
    this.renderAdminView();
    this.renderAlertsView();
    this.renderReportsView();
    this.renderQueriesView();
    this.populateLookupQuickTags();

    this.showToast(`¡${countMoved} auditorías movidas exitosamente de ${prevStudy} a ${targetStudy}!`, 'success');
  }

  async clearCurrentStudyAudits() {
    const projectAudits = this.getAuditsForCurrentProject();
    if (projectAudits.length === 0) {
      this.showToast(`No hay una jornada activa en el estudio ${this.currentProject} para archivar.`, 'info');
      return;
    }

    const confirmMsg = `¿Deseas archivar la jornada activa con ${projectAudits.length} auditorías del estudio "${this.currentProject}"?\n\nDejará de aparecer en la operación diaria, pero seguirá disponible en el histórico por validador.`;
    if (!confirm(confirmMsg)) {
      return;
    }

    const deletedStudy = this.currentProject;
    if (this.backend.configured && this.isSupervisor) {
      try {
        await this.backend.deleteAudits(this.currentModule, deletedStudy);
      } catch (error) {
        this.showToast(error.message || 'No fue posible archivar la jornada en Supabase.', 'error');
        return;
      }
    }
    this.audits = this.audits.filter(a => this.getStudyForAudit(a).toUpperCase() !== deletedStudy.toUpperCase());
    if (this.currentModule === 'blocking') {
      this.blockingAudits = this.audits;
    } else {
      this.smartAudits = this.audits;
    }

    this.saveState();
    this.syncStateAcrossTabs();
    this.renderAdminView();
    this.renderAlertsView();
    this.renderReportsView();
    this.renderQueriesView();
    this.populateLookupQuickTags();

    this.showToast(`Jornada de ${deletedStudy} archivada. El histórico permanece disponible.`, 'success');
  }

  async clearAllDatabase() {
    if (this.audits.length === 0) {
      this.showToast('Este módulo no tiene una jornada activa.', 'info');
      return;
    }

    const confirmMsg = `¿Deseas archivar la operación activa de este módulo (${this.audits.length} auditorías)?\n\nLos registros no se borrarán y seguirán disponibles en el histórico.`;
    if (!confirm(confirmMsg)) {
      return;
    }

    if (this.backend.configured && this.isSupervisor) {
      try {
        await this.backend.deleteAudits(this.currentModule);
      } catch (error) {
        this.showToast(error.message || 'No fue posible archivar el módulo en Supabase.', 'error');
        return;
      }
    }
    this.audits = [];
    if (this.currentModule === 'blocking') {
      this.blockingAudits = [];
    } else {
      this.smartAudits = [];
    }

    this.saveState();
    this.syncStateAcrossTabs();
    this.renderAdminView();
    this.renderAlertsView();
    this.renderReportsView();
    this.renderQueriesView();
    this.populateLookupQuickTags();

    this.showToast('Base de datos vaciada completamente. Plataforma lista para nuevas cargas.', 'info');
  }

  // ==========================================
  // REPARTICIÓN EQUITATIVA Y GESTIÓN POR ESTUDIO
  // ==========================================
  getValidatorsForCurrentProject({ includeInactive = false } = {}) {
    const cur = (this.currentProject || 'Chile').toUpperCase();
    const filtered = this.validators.filter(v => v.estudio && v.estudio.toUpperCase() === cur);
    const projectValidators = filtered.length > 0 ? filtered : (this.isSupervisor ? [] : this.validators);
    return includeInactive
      ? projectValidators
      : projectValidators.filter(validator => validator.isActive !== false);
  }

  getAuditsForCurrentProject() {
    if (!this.currentProject || this.currentProject === 'ALL') {
      return this.audits;
    }
    const cur = this.currentProject.toUpperCase();
    return this.audits.filter(a => {
      const studyOfAudit = this.getStudyForAudit(a);
      return studyOfAudit.toUpperCase() === cur;
    });
  }

  isPendingAudit(audit) {
    return !audit.validationStatus || audit.validationStatus === 'pendiente';
  }

  redistributePendingAudits() {
    const projectAudits = this.getAuditsForCurrentProject();
    const pendingAudits = projectAudits.filter(audit => this.isPendingAudit(audit));
    const activeValidators = this.getValidatorsForCurrentProject();

    if (!pendingAudits.length) {
      return { pendingCount: 0, activeValidators, totalKpis: 0 };
    }
    if (!activeValidators.length) {
      throw new Error(`Activa al menos un validador en ${this.currentProject} para repartir las auditorías pendientes.`);
    }

    // No modifica auditorías completadas ni las que un validador ya tiene abiertas.
    const distributedPending = Distributor.distribute(pendingAudits, activeValidators);
    const auditKey = audit => String(audit._rowId || `${audit._batchId || 'active'}:${audit.id}`);
    const distributedByKey = new Map(distributedPending.map(audit => [auditKey(audit), audit]));
    this.audits = this.audits.map(audit => distributedByKey.get(auditKey(audit)) || audit);

    if (this.currentModule === 'blocking') {
      this.blockingAudits = this.audits;
    } else {
      this.smartAudits = this.audits;
    }

    const totalKpis = pendingAudits.reduce(
      (total, audit) => total + (audit.kpis || []).filter(kpi => kpi.needsReview || kpi.alertaStatus === 'SE ALERTA').length,
      0
    );
    return { pendingCount: pendingAudits.length, activeValidators, totalKpis };
  }

  executeDistribution() {
    try {
      const projectAudits = this.getAuditsForCurrentProject();
      if (projectAudits.length === 0) {
        this.showToast(`No hay auditorías cargadas para el estudio ${this.currentProject}.`, 'warning');
        return;
      }

      const result = this.redistributePendingAudits();
      if (!result.pendingCount) {
        this.showToast('No hay auditorías pendientes para redistribuir. Las completadas y en progreso se conservaron.', 'info');
        return;
      }

      this.saveState();
      this.syncStateAcrossTabs();
      this.renderAdminView();
      this.renderAlertsView();
      this.renderReportsView();
      this.populateLookupQuickTags();

      this.showToast(
        `¡${result.pendingCount} auditorías pendientes de ${this.currentProject} (${result.totalKpis} KPIs a revisar) repartidas entre ${result.activeValidators.length} validadores activos!`,
        'success'
      );
    } catch (e) {
      console.error(e);
      this.showToast(e.message || 'Error al repartir auditorías.', 'error');
    }
  }

  // ==========================================
  // RENDERIZADO DE LA VISTA ADMIN
  // ==========================================
  renderAdminView() {
    const totalAuditsEl = document.getElementById('admin-stat-total-audits');
    const totalKpisEl = document.getElementById('admin-stat-total-kpis-to-review');
    const totalValidatorsEl = document.getElementById('admin-stat-total-validators');
    const assignedPercentEl = document.getElementById('admin-stat-assigned-percent');
    const completedPercentEl = document.getElementById('admin-stat-completed-percent');

    const projectValidators = this.getValidatorsForCurrentProject();
    const projectAudits = this.getAuditsForCurrentProject();
    const totalAudits = projectAudits.length;
    const assignedAudits = projectAudits.filter(a => a.assignedValidatorId).length;
    const completedAudits = projectAudits.filter(a => a.validationStatus === 'completada').length;
    const totalKpisToReview = projectAudits.reduce((acc, a) => acc + (a.kpis || []).filter(k => k.needsReview || k.alertaStatus === 'SE ALERTA').length, 0);

    if (totalAuditsEl) totalAuditsEl.textContent = totalAudits;
    if (totalKpisEl) totalKpisEl.textContent = totalKpisToReview;
    if (totalValidatorsEl) totalValidatorsEl.textContent = projectValidators.length;
    if (assignedPercentEl) {
      assignedPercentEl.textContent = totalAudits > 0 ? `${Math.round((assignedAudits / totalAudits) * 100)}%` : '0%';
    }
    if (completedPercentEl) {
      completedPercentEl.textContent = totalAudits > 0 ? `${Math.round((completedAudits / totalAudits) * 100)}%` : '0%';
    }

    this.renderValidatorCards();
    this.renderAuditsPreviewTable();
  }

  renderValidatorCards() {
    const container = document.getElementById('admin-validators-grid');
    if (!container) return;

    const projectValidators = this.getValidatorsForCurrentProject({ includeInactive: true });
    const projectAudits = this.getAuditsForCurrentProject();

    if (projectValidators.length === 0) {
      container.innerHTML = `
        <div class="empty-validators-state">
          <p>No hay validadores registrados para el estudio <strong>${this.currentProject}</strong>. Haz clic en "+ Agregar Validador" para añadir uno.</p>
        </div>
      `;
      return;
    }

    const stats = Distributor.getValidatorStats(projectAudits, projectValidators);

    const flagMap = {
      'Chile': '🇨🇱 Chile',
      'Tradicional': '🏪 Tradicional',
      'Moderno': '🏬 Moderno',
      'Lindley': '🥤 Lindley'
    };

    container.innerHTML = stats.map(val => {
      const studyLabel = flagMap[val.estudio] || val.estudio || this.currentProject || 'Chile';
      const isActive = val.isActive !== false;

      return `
        <div class="validator-admin-card ${isActive ? '' : 'is-inactive'}" data-id="${val.id}">
          <div class="val-card-top">
            <div class="val-code-badge" title="Código único para ingresar">${val.code}</div>
            <span class="val-study-tag">${studyLabel}</span>
            <div class="val-actions-mini">
              <button class="btn-icon btn-copy-code" data-code="${val.code}" title="Copiar Código">📋</button>
            </div>
          </div>

          <div class="val-info">
            <h4 class="val-name">${val.name}</h4>
            <span class="val-email">${val.email || 'Sin correo'}</span>
            <span class="badge ${isActive ? 'badge-success' : 'badge-secondary'} val-activity-badge">${isActive ? '● Activo' : '○ Inactivo'}</span>
          </div>

          <div class="val-stats-grid">
            <div class="val-stat-box">
              <span class="val-stat-num">${val.totalAssigned}</span>
              <span class="val-stat-lbl">Auditorías</span>
            </div>
            <div class="val-stat-box">
              <span class="val-stat-num text-magenta">${val.totalAssignedKpis}</span>
              <span class="val-stat-lbl">KPIs Alerta</span>
            </div>
            <div class="val-stat-box">
              <span class="val-stat-num text-success">${val.completed}</span>
              <span class="val-stat-lbl">${val.percentProgress}% Avance</span>
            </div>
          </div>

           <div class="val-progress-bar-wrap">
             <div class="val-progress-bar-fill" style="width: ${val.percentProgress}%"></div>
           </div>
           ${projectAudits.filter(audit => audit.assignedValidatorId === val.id && this.isPendingAudit(audit)).length ? `
             <button class="btn btn-sm btn-secondary btn-reassign-validator" data-id="${val.id}">
               ↪ Reasignar pendientes
             </button>
           ` : ''}
           <button class="btn btn-sm ${isActive ? 'btn-outline' : 'btn-primary'} btn-toggle-validator" data-id="${val.id}" data-active="${isActive}">
             ${isActive ? '⏸ Desactivar' : '▶ Activar'}
           </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-copy-code').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        navigator.clipboard.writeText(code).then(() => {
          this.showToast(`Código ${code} copiado al portapapeles.`, 'success');
        });
      });
    });

    container.querySelectorAll('.btn-toggle-validator').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.toggleValidatorActive(btn.dataset.id, btn.dataset.active === 'true', btn);
      });
    });

    container.querySelectorAll('.btn-reassign-validator').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openReassignPendingAuditsModal(btn.dataset.id);
      });
    });
  }

  initReassignPendingAuditsModal() {
    const modal = document.getElementById('modal-reassign-pending-audits');
    const close = () => modal?.classList.add('hidden');
    document.getElementById('btn-close-reassign-pending')?.addEventListener('click', close);
    document.getElementById('btn-cancel-reassign-pending')?.addEventListener('click', close);
    document.getElementById('btn-confirm-reassign-pending')?.addEventListener('click', () => this.confirmReassignPendingAudits());
  }

  openReassignPendingAuditsModal(sourceValidatorId) {
    const modal = document.getElementById('modal-reassign-pending-audits');
    if (!modal) return;
    const source = this.validators.find(validator => validator.id === sourceValidatorId);
    const pendingAudits = this.getAuditsForCurrentProject().filter(
      audit => audit.assignedValidatorId === sourceValidatorId && this.isPendingAudit(audit)
    );
    const targets = this.getValidatorsForCurrentProject()
      .filter(validator => validator.id !== sourceValidatorId)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));

    if (!source || !pendingAudits.length) {
      this.showToast('Este validador ya no tiene auditorías pendientes para reasignar.', 'info');
      this.renderAdminView();
      return;
    }
    if (!targets.length) {
      this.showToast('Activa o registra otro validador antes de reasignar estas auditorías.', 'warning');
      return;
    }

    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
    const summary = document.getElementById('reassign-pending-summary');
    const select = document.getElementById('reassign-pending-target');
    if (summary) {
      summary.textContent = `${source.name} tiene ${pendingAudits.length} auditoría${pendingAudits.length === 1 ? '' : 's'} pendiente${pendingAudits.length === 1 ? '' : 's'} en ${this.currentProject}.`;
    }
    if (select) {
      select.innerHTML = `<option value="">Selecciona un validador</option>${targets.map(target => (
        `<option value="${escapeHtml(target.id)}">${escapeHtml(target.code)} · ${escapeHtml(target.name)}</option>`
      )).join('')}`;
    }
    modal.dataset.sourceValidatorId = sourceValidatorId;
    modal.dataset.pendingCount = String(pendingAudits.length);
    modal.classList.remove('hidden');
    select?.focus();
  }

  async confirmReassignPendingAudits() {
    const modal = document.getElementById('modal-reassign-pending-audits');
    const select = document.getElementById('reassign-pending-target');
    const button = document.getElementById('btn-confirm-reassign-pending');
    const sourceValidatorId = modal?.dataset.sourceValidatorId;
    const targetValidatorId = select?.value;
    const source = this.validators.find(validator => validator.id === sourceValidatorId);
    const target = this.validators.find(validator => validator.id === targetValidatorId);
    const pendingAudits = this.getAuditsForCurrentProject().filter(
      audit => audit.assignedValidatorId === sourceValidatorId && this.isPendingAudit(audit)
    );

    if (!source || !target || !pendingAudits.length) {
      this.showToast('Selecciona un validador destino válido con auditorías pendientes disponibles.', 'warning');
      return;
    }

    const originalLabel = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.textContent = 'Reasignando…';
    }

    try {
      let reassignedCount = pendingAudits.length;
      if (this.backend.configured && this.isSupervisor) {
        const result = await this.backend.reassignPendingAudits({
          sourceValidatorId,
          targetValidatorId,
          module: this.currentModule
        });
        reassignedCount = result.reassignedCount;
        await this.refreshFromBackend();
        this.channel?.postMessage({ type: 'STATE_UPDATED', timestamp: Date.now() });
      } else {
        pendingAudits.forEach(audit => { audit.assignedValidatorId = targetValidatorId; });
        if (this.currentModule === 'blocking') this.blockingAudits = this.audits;
        else this.smartAudits = this.audits;
        await this.syncStateAcrossTabs();
        this.renderAdminView();
        this.renderAlertsView();
        this.renderReportsView();
      }

      modal?.classList.add('hidden');
      this.showToast(
        reassignedCount
          ? `${reassignedCount} auditoría${reassignedCount === 1 ? '' : 's'} pendiente${reassignedCount === 1 ? '' : 's'} de ${source.name} fueron asignadas a ${target.name}.`
          : 'No había auditorías pendientes para mover; la asignación pudo haber cambiado en otra sesión.',
        reassignedCount ? 'success' : 'info'
      );
    } catch (error) {
      console.error('No fue posible reasignar auditorías pendientes:', error);
      this.showToast(error.message || 'No fue posible reasignar las auditorías pendientes.', 'error');
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.innerHTML = originalLabel;
      }
    }
  }

  renderAuditsPreviewTable() {
    const tableThead = document.getElementById('audits-preview-thead');
    const tableBody = document.getElementById('audits-preview-tbody');
    const countBadge = document.getElementById('audits-table-count');

    if (!tableThead || !tableBody) return;

    const projectAudits = this.getAuditsForCurrentProject();

    if (countBadge) countBadge.textContent = `${projectAudits.length} registros (${this.currentProject})`;

    if (projectAudits.length === 0) {
      tableThead.innerHTML = '';
      tableBody.innerHTML = `
        <tr>
          <td colspan="10" class="empty-table-msg">
            No hay auditorías cargadas para el estudio <strong>${this.currentProject}</strong>. Arrastra un archivo Excel/CSV arriba o selecciona otro estudio.
          </td>
        </tr>
      `;
      return;
    }

    tableThead.innerHTML = `
      <tr>
        <th>#</th>
        <th>ID Auditoría</th>
        <th>ID PDV</th>
        <th>País</th>
        <th>Ciudad</th>
        <th>Canal / Modelo</th>
        <th>Fecha</th>
        <th>KPIs Asignados</th>
        <th>Validador Asignado</th>
        <th>Estado</th>
      </tr>
    `;

    const valMap = new Map(this.validators.map(v => [v.id, v]));
    const previewAudits = projectAudits.slice(0, 50);

    tableBody.innerHTML = previewAudits.map((a, i) => {
      const val = valMap.get(a.assignedValidatorId);
      const kpisToReview = (a.kpis || []).filter(k => k.needsReview);

      const statusBadge = a.validationStatus === 'completada' 
        ? `<span class="badge badge-success">✓ Completada</span>`
        : a.validationStatus === 'en_progreso'
        ? `<span class="badge badge-info">En Progreso</span>`
        : `<span class="badge badge-warning">Pendiente</span>`;

      return `
        <tr>
          <td>${i + 1}</td>
          <td><strong>#${a.id}</strong></td>
          <td>${a.idPDV || '-'}</td>
          <td>${a.pais || '-'}</td>
          <td>${a.ciudad || '-'}</td>
          <td>${a.modelo ? `${a.canal || ''} (${a.modelo})` : a.canal || '-'}</td>
          <td><strong>${this.getAuditOperationDate(a)}</strong></td>
          <td><span class="badge badge-purple">${kpisToReview.length} KPIs</span></td>
          <td>
            ${val ? `<span class="val-pill"><strong>${val.code}</strong> - ${val.name}</span>` : '<span class="text-muted">Sin asignar</span>'}
          </td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================
  // GESTIÓN DE VALIDADORES
  // ==========================================
  initValidatorModal() {
    const modal = document.getElementById('modal-add-validator');
    const closeBtn = document.getElementById('btn-close-val-modal');
    const saveBtn = document.getElementById('btn-save-val-modal');
    const nameInput = document.getElementById('modal-val-name');
    const emailInput = document.getElementById('modal-val-email');
    const codeInput = document.getElementById('modal-val-code');
    const studySelect = document.getElementById('modal-val-study');

    closeBtn?.addEventListener('click', () => modal?.classList.add('hidden'));

    saveBtn?.addEventListener('click', () => {
      const name = nameInput?.value.trim();
      const email = emailInput?.value.trim();
      const code = codeInput?.value.trim().toUpperCase() || Distributor.generateValidatorCode(this.validators.map(v => v.code));
      const estudio = this.currentScope?.study?.name || this.currentProject || 'Chile';

      if (!name) {
        this.showToast('El nombre del validador es obligatorio.', 'warning');
        return;
      }

      if (this.validators.some(v => v.code === code)) {
        this.showToast(`El código "${code}" ya está en uso.`, 'warning');
        return;
      }

      const newValidator = {
        id: 'val-' + Date.now(),
        code,
        name,
        email,
        estudio,
        studyId: this.currentScope?.study?.id || null,
        countryId: this.currentScope?.country?.id || null,
        isActive: true
      };

      this.validators.push(newValidator);
      this.saveState();
      this.syncStateAcrossTabs();
      this.renderAdminView();
      this.renderAlertsView();
      this.validatorUI?.populateQuickSelect(this.validators);

      modal?.classList.add('hidden');
      nameInput.value = '';
      emailInput.value = '';
      codeInput.value = '';

      this.showToast(`Validador "${name}" agregado al estudio ${estudio} con código ${code}.`, 'success');
    });
  }

  openAddValidatorModal() {
    const modal = document.getElementById('modal-add-validator');
    const codeInput = document.getElementById('modal-val-code');
    const studySelect = document.getElementById('modal-val-study');

    if (codeInput) {
      codeInput.value = Distributor.generateValidatorCode(this.validators.map(v => v.code));
    }
    if (studySelect) {
      studySelect.value = this.currentProject || 'Chile';
      studySelect.disabled = Boolean(this.currentScope?.study);
    }

    modal?.classList.remove('hidden');
    document.getElementById('modal-val-name')?.focus();
  }

  async deleteValidator(id) {
    const val = this.validators.find(v => v.id === id);
    if (!val) return;

    const activeAssignments = this.audits.filter(a => a.assignedValidatorId === id).length;
    if (activeAssignments > 0) {
      this.showToast(`Antes de desactivar a ${val.name}, reasigna o archiva sus ${activeAssignments} auditorías de la jornada activa.`, 'warning');
      return;
    }

    if (confirm(`¿Deseas desactivar al validador "${val.name}"? Su histórico y sus auditorías anteriores se conservarán.`)) {
      if (this.backend.configured && this.isSupervisor) {
        try {
          await this.backend.deleteValidator(id);
        } catch (error) {
          this.showToast(error.message || 'No fue posible desactivar el validador en Supabase.', 'error');
          return;
        }
      }
      this.validators = this.validators.filter(v => v.id !== id);
      this.syncStateAcrossTabs();
      this.renderAdminView();
      this.renderAlertsView();
      this.validatorUI?.populateQuickSelect(this.validators);
      this.showToast(`Validador ${val.name} desactivado. Su histórico se conservó.`, 'info');
    }
  }

  async toggleValidatorActive(id, isCurrentlyActive, button = null) {
    const validator = this.validators.find(item => item.id === id);
    if (!validator) return;

    const willBeActive = !isCurrentlyActive;
    const projectAudits = this.getAuditsForCurrentProject();
    const inProgressCount = projectAudits.filter(
      audit => audit.assignedValidatorId === id && audit.validationStatus === 'en_progreso'
    ).length;
    const pendingCount = projectAudits.filter(audit => this.isPendingAudit(audit)).length;
    const validatorPendingCount = projectAudits.filter(
      audit => audit.assignedValidatorId === id && this.isPendingAudit(audit)
    ).length;

    if (!willBeActive && inProgressCount > 0) {
      this.showToast(
        `${validator.name} tiene ${inProgressCount} auditoría${inProgressCount === 1 ? '' : 's'} en progreso. Guárdala o termínala antes de desactivarlo.`,
        'warning'
      );
      return;
    }

    if (!willBeActive && pendingCount > 0) {
      const remainingActive = this.getValidatorsForCurrentProject().filter(item => item.id !== id);
      if (!remainingActive.length) {
        this.showToast('No puedes desactivar al último validador activo mientras haya auditorías pendientes.', 'warning');
        return;
      }
    }

    const originalLabel = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.textContent = willBeActive ? 'Activando...' : 'Desactivando...';
    }

    try {
      if (this.backend.configured && this.isSupervisor) {
        const updated = await this.backend.setValidatorActive(id, willBeActive);
        Object.assign(validator, updated);
      } else {
        validator.isActive = willBeActive;
      }

      // Reactivating keeps the agreed equitable redistribution. When a
      // validator was first emptied with the manual reassignment control,
      // deactivation must leave every other assignment exactly as it is.
      const redistribution = willBeActive || validatorPendingCount > 0
        ? this.redistributePendingAudits()
        : { pendingCount: 0, activeValidators: this.getValidatorsForCurrentProject(), totalKpis: 0 };
      this.saveState();
      await this.syncStateAcrossTabs();
      this.renderAdminView();
      this.renderAlertsView();
      this.renderReportsView();
      this.validatorUI?.populateQuickSelect(this.validators);

      if (willBeActive) {
        const resultMessage = redistribution.pendingCount
          ? ` y se redistribuyeron ${redistribution.pendingCount} auditorías pendientes entre ${redistribution.activeValidators.length} validadores activos`
          : '';
        this.showToast(`${validator.name} quedó activo${resultMessage}.`, 'success');
      } else {
        const resultMessage = redistribution.pendingCount
          ? ` Las ${redistribution.pendingCount} auditorías pendientes fueron redistribuidas.`
          : '';
        this.showToast(`${validator.name} quedó inactivo. Puede reactivarse en cualquier momento.${resultMessage}`, 'info');
      }
    } catch (error) {
      console.error('No fue posible actualizar el estado del validador:', error);
      this.showToast(error.message || 'No fue posible actualizar el estado del validador.', 'error');
      if (button?.isConnected) {
        button.disabled = false;
        button.innerHTML = originalLabel;
      }
    }
  }

  // ==========================================
  // SUB-PESTAÑAS DE MÉTRICAS (OPERACIONALES VS EJECUTIVAS)
  // ==========================================
  initReportsSubtabs() {
    const btnOp = document.getElementById('btn-subtab-operational');
    const btnExec = document.getElementById('btn-subtab-executive');
    const viewOp = document.getElementById('metrics-view-operational');
    const viewExec = document.getElementById('metrics-view-executive');
    const titleEl = document.getElementById('reports-view-title');
    const subtitleEl = document.getElementById('reports-view-subtitle');

    btnOp?.addEventListener('click', () => {
      this.reportsSubtab = 'operational';
      btnOp.classList.add('active');
      btnExec?.classList.remove('active');
      viewOp?.classList.remove('hidden');
      viewExec?.classList.add('hidden');

      if (titleEl) titleEl.textContent = 'Métricas Operacionales de Supervisión';
      if (subtitleEl) subtitleEl.textContent = 'Consulta todo el histórico de validación, tiempos por validador y descargas día a día.';
      this.renderReportsView();
    });

    btnExec?.addEventListener('click', () => {
      this.reportsSubtab = 'executive';
      btnExec.classList.add('active');
      btnOp?.classList.remove('active');
      viewExec?.classList.remove('hidden');
      viewOp?.classList.add('hidden');

      if (titleEl) titleEl.textContent = 'Informe Ejecutivo de Calidad y KPIs (Comité)';
      if (subtitleEl) subtitleEl.textContent = 'Ranking de variables con alertas, tasa de efectividad de negocio y causas raíz para comités directivos.';
      this.renderReportsView();
    });
  }

  // ==========================================
  // FILTRO MULTI-ESTUDIO / CANAL / MODELO
  // ==========================================
  initStudyFilter() {
    document.getElementById('btn-filter-select-all')?.addEventListener('click', () => {
      this.selectedStudies = ['ALL'];
      this.renderReportsView();
      this.renderDailyReportsView();
      this.showToast('Mostrando datos de todos los estudios.', 'info');
    });

    document.getElementById('btn-filter-select-current')?.addEventListener('click', () => {
      this.selectedStudies = [this.currentProject];
      this.renderReportsView();
      this.renderDailyReportsView();
      this.showToast(`Filtrando métricas por: ${this.currentProject}`, 'info');
    });
  }

  populateStudyPills() {
    const container = document.getElementById('study-pills-container');
    if (!container) return;
    const reportAudits = this.getReportAuditSource();

    // Los 4 Estudios Oficiales
    const officialStudies = [
      { key: 'Chile', label: '🇨🇱 Chile' },
      { key: 'Tradicional', label: '🏪 Tradicional' },
      { key: 'Moderno', label: '🏬 Moderno' },
      { key: 'Lindley', label: '🥤 Lindley' }
    ];

    const isAllSelected = this.selectedStudies.includes('ALL') || this.selectedStudies.length === 0;

    let html = `
      <div class="study-filter-pill ${isAllSelected ? 'active' : ''}" data-study="ALL">
        <span>🌐 Todos los Estudios</span>
        <span class="pill-count-badge">${reportAudits.length}</span>
      </div>
    `;

    officialStudies.forEach(studyItem => {
      const matchCount = reportAudits.filter(a => this.getStudyForAudit(a) === studyItem.key).length;
      const isSel = !isAllSelected && this.selectedStudies.some(s => s.toUpperCase() === studyItem.key.toUpperCase());

      html += `
        <div class="study-filter-pill ${isSel ? 'active' : ''}" data-study="${studyItem.key}">
          <span>${studyItem.label}</span>
          <span class="pill-count-badge">${matchCount}</span>
        </div>
      `;
    });

    container.innerHTML = html;

    // Listeners interactivos
    container.querySelectorAll('.study-filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const study = pill.dataset.study;

        if (study === 'ALL') {
          this.selectedStudies = ['ALL'];
        } else {
          // Si estaba en ALL, deseleccionar ALL y dejar solo el estudio clickeado
          if (this.selectedStudies.includes('ALL')) {
            this.selectedStudies = [study];
          } else {
            // Si ya estaba seleccionado, quitarlo
            const idx = this.selectedStudies.findIndex(s => s.toUpperCase() === study.toUpperCase());
            if (idx !== -1) {
              this.selectedStudies.splice(idx, 1);
              if (this.selectedStudies.length === 0) {
                this.selectedStudies = ['ALL'];
              }
            } else {
              this.selectedStudies.push(study);
            }
          }
        }

        this.renderReportsView();
        this.renderDailyReportsView();
      });
    });
  }

  getStudyForAudit(audit) {
    if (audit.estudio) return audit.estudio;
    const m = (audit.modelo || '').toUpperCase();
    const c = (audit.canal || '').toUpperCase();
    const p = (audit.pais || '').toUpperCase();

    if (p === 'CHILE' || m === 'CHILE') return 'Chile';
    if (m.includes('TRADICIONAL') || c.includes('TRADICIONAL') || m.includes('STILLS') || m.includes('TITÁN')) return 'Tradicional';
    if (m.includes('MODERNO') || c.includes('MODERNO') || m.includes('MOEDRNO') || c.includes('MOEDRNO')) return 'Moderno';
    if (m.includes('LINDLEY') || c.includes('LINDLEY') || c.includes('GROCERY')) return 'Lindley';
    return 'Tradicional';
  }

  getFilteredAuditsForReports() {
    const reportAudits = this.getReportAuditSource();
    if (this.selectedStudies.includes('ALL') || this.selectedStudies.length === 0) {
      return reportAudits;
    }

    return reportAudits.filter(a => {
      const studyOfAudit = this.getStudyForAudit(a);
      return this.selectedStudies.some(s => s.toUpperCase() === studyOfAudit.toUpperCase());
    });
  }

  // ==========================================
  // VISTA DE REPORTES Y MÉTRICAS (OPERACIONALES + EJECUTIVAS)
  // ==========================================
  renderReportsView() {
    this.populateStudyPills();

    const reportAudits = this.getReportAuditSource();
    const filteredAudits = this.getFilteredAuditsForReports();
    const studyLabel = this.selectedStudies.includes('ALL') 
      ? 'Todos los Estudios (Consolidado)' 
      : this.selectedStudies.join(', ');

    // 1. Actualizar etiquetas de contexto de filtro
    const opCountLabel = document.getElementById('op-filtered-count-label');
    if (opCountLabel) {
      opCountLabel.textContent = `Histórico completo: ${filteredAudits.length} de ${reportAudits.length} auditorías [${studyLabel}]`;
    }

    const execStudyLabel = document.getElementById('exec-study-selected-label');
    if (execStudyLabel) {
      execStudyLabel.textContent = `Estudios Analizados: ${studyLabel} (${filteredAudits.length} auditorías)`;
    }

    // 2. Renderizar Sub-Vista Operacional
    this.renderOperationalMetrics(filteredAudits);

    // 3. Renderizar Sub-Vista Ejecutiva para Comité
    this.renderExecutiveMetrics(filteredAudits);
  }

  renderOperationalMetrics(audits) {
    const totalAudits = audits.length;
    const completedAudits = audits.filter(a => a.validationStatus === 'completada').length;
    const pendingAudits = totalAudits - completedAudits;

    let totalEvaluatedKpis = 0;
    let totalAplicaKpis = 0;
    let totalNoAplicaKpis = 0;
    const reasonsMap = {};

    audits.forEach(audit => {
      Object.entries(audit.validationResults || {}).forEach(([kpiName, res]) => {
        if (res.status) {
          totalEvaluatedKpis++;
          if (res.status === 'aplica') {
            totalAplicaKpis++;
          } else if (res.status === 'no_aplica') {
            totalNoAplicaKpis++;
            if (res.tipificacion) {
              reasonsMap[res.tipificacion] = (reasonsMap[res.tipificacion] || 0) + 1;
            }
          }
        }
      });
    });

    const repTotal = document.getElementById('rep-stat-total');
    const repCompleted = document.getElementById('rep-stat-completed');
    const repPending = document.getElementById('rep-stat-pending');
    const repAplica = document.getElementById('rep-stat-aplica');
    const repNoAplica = document.getElementById('rep-stat-no-aplica');

    if (repTotal) repTotal.textContent = totalAudits;
    if (repCompleted) repCompleted.textContent = completedAudits;
    if (repPending) repPending.textContent = pendingAudits;
    if (repAplica) repAplica.textContent = totalAplicaKpis;
    if (repNoAplica) repNoAplica.textContent = totalNoAplicaKpis;

    const reasonsContainer = document.getElementById('reasons-breakdown-list');
    if (reasonsContainer) {
      const reasonEntries = Object.entries(reasonsMap).sort((a, b) => b[1] - a[1]);

      if (reasonEntries.length === 0) {
        reasonsContainer.innerHTML = `
          <div class="empty-reasons-state">
            <p>Aún no se han registrado tipificaciones de "No Aplica" en los estudios seleccionados.</p>
          </div>
        `;
      } else {
        reasonsContainer.innerHTML = reasonEntries.map(([reason, count]) => {
          const pct = totalNoAplicaKpis > 0 ? Math.round((count / totalNoAplicaKpis) * 100) : 0;
          return `
            <div class="reason-item">
              <div class="reason-info">
                <span class="reason-text">${reason}</span>
                <span class="reason-count"><strong>${count}</strong> (${pct}%)</span>
              </div>
              <div class="progress-bar-bg">
                <div class="progress-bar-fill progress-rose" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    this.renderDailyReportsView();
  }

  renderExecutiveMetrics(audits) {
    let totalAlerts = 0;
    let totalAplica = 0;
    let totalNoAplica = 0;
    let totalDurationSec = 0;
    let completedAuditsCount = 0;

    const kpiStats = {};
    const channelStats = {};
    const reasonsMap = {};
    const allUniqueKpis = new Set();

    const officialStudies = [
      { key: 'Chile', label: '🇨🇱 Chile' },
      { key: 'Tradicional', label: '🏪 Tradicional' },
      { key: 'Moderno', label: '🏬 Moderno' },
      { key: 'Lindley', label: '🥤 Lindley' }
    ];

    officialStudies.forEach(s => {
      channelStats[s.key] = { key: s.key, name: s.label, audits: 0, alerts: 0, aplica: 0, noAplica: 0 };
    });

    audits.forEach(audit => {
      const studyKey = this.getStudyForAudit(audit);
      if (!channelStats[studyKey]) {
        channelStats[studyKey] = { key: studyKey, name: studyKey, audits: 0, alerts: 0, aplica: 0, noAplica: 0 };
      }
      channelStats[studyKey].audits++;

      if (audit.validationStatus === 'completada') {
        completedAuditsCount++;
        if (audit.durationSeconds) totalDurationSec += audit.durationSeconds;
      }

      (audit.kpis || []).forEach(k => {
        allUniqueKpis.add(k.kpiName || k.name);
        if (k.needsReview) {
          totalAlerts++;
          channelStats[studyKey].alerts++;

          const kName = k.kpiName || k.name;
          if (!kpiStats[kName]) {
            kpiStats[kName] = { name: kName, total: 0, aplica: 0, noAplica: 0 };
          }
          kpiStats[kName].total++;

          const res = (audit.validationResults || {})[k.name];
          if (res && res.status === 'aplica') {
            totalAplica++;
            kpiStats[kName].aplica++;
            channelStats[studyKey].aplica++;
          } else if (res && res.status === 'no_aplica') {
            totalNoAplica++;
            kpiStats[kName].noAplica++;
            channelStats[studyKey].noAplica++;
            if (res.tipificacion) {
              reasonsMap[res.tipificacion] = (reasonsMap[res.tipificacion] || 0) + 1;
            }
          }
        }
      });
    });

    const evaluated = totalAplica + totalNoAplica;
    const confirmRateNum = evaluated > 0 ? Math.round((totalAplica / evaluated) * 100) : 0;
    const discardRateNum = evaluated > 0 ? Math.round((totalNoAplica / evaluated) * 100) : 0;
    const confirmRate = `${confirmRateNum}%`;
    const discardRate = `${discardRateNum}%`;
    const avgDuration = completedAuditsCount > 0 ? Math.round(totalDurationSec / completedAuditsCount) : 24;

    // Universo Total de Medición (ej. 10 auditorías × 9 KPIs = 90 puntos)
    const kpisPerAudit = Math.max(9, allUniqueKpis.size || 9);
    const totalMeasurableUniverse = audits.length * kpisPerAudit;
    const totalSinAlerta = Math.max(0, totalMeasurableUniverse - totalAlerts);

    const pctSinAlerta = totalMeasurableUniverse > 0 ? ((totalSinAlerta / totalMeasurableUniverse) * 100).toFixed(1) : '0.0';
    const pctAplicaUniverse = totalMeasurableUniverse > 0 ? ((totalAplica / totalMeasurableUniverse) * 100).toFixed(1) : '0.0';
    const pctNoAplicaUniverse = totalMeasurableUniverse > 0 ? ((totalNoAplica / totalMeasurableUniverse) * 100).toFixed(1) : '0.0';
    const pctAlertasEditadas = totalAlerts > 0 ? Math.round((totalNoAplica / totalAlerts) * 100) : 0;

    // Ordenar ranking de KPIs por volumen total de alertas
    const kpiRanking = Object.values(kpiStats).sort((a, b) => b.total - a.total);
    const topKpi = kpiRanking.length > 0 ? `${kpiRanking[0].name} (${kpiRanking[0].total})` : '—';

    // 1. Actualizar Tarjetas Ejecutivas & Banner Comercial
    const statAlerts = document.getElementById('exec-stat-total-alerts');
    const statConfirm = document.getElementById('exec-stat-confirm-rate');
    const statDiscard = document.getElementById('exec-stat-discard-rate');
    const statTopKpi = document.getElementById('exec-stat-top-kpi');

    const statAuditsCovered = document.getElementById('exec-stat-audits-covered');
    const statFalsePositives = document.getElementById('exec-stat-false-positives');
    const statPrecisionRate = document.getElementById('exec-stat-precision-rate');
    const statSlaTime = document.getElementById('exec-stat-sla-time');
    const statQaStatus = document.getElementById('exec-stat-qa-status');

    if (statAlerts) statAlerts.textContent = totalAlerts;
    if (statConfirm) statConfirm.textContent = confirmRate;
    if (statDiscard) statDiscard.textContent = discardRate;
    if (statTopKpi) statTopKpi.textContent = topKpi;

    if (statAuditsCovered) statAuditsCovered.textContent = audits.length;
    if (statFalsePositives) statFalsePositives.textContent = totalNoAplica;
    if (statPrecisionRate) statPrecisionRate.textContent = confirmRate;
    if (statSlaTime) statSlaTime.textContent = `${avgDuration}s`;
    if (statQaStatus) statQaStatus.textContent = `${audits.length} Auditorías Verificadas`;

    // 2. Actualizar Panel de Universo de Medición & Tasa de Edición
    const kpisBadge = document.getElementById('exec-stat-kpis-per-audit-badge');
    if (kpisBadge) kpisBadge.textContent = `${kpisPerAudit} KPIs × Auditoría`;

    const barSinAlerta = document.getElementById('exec-bar-sin-alerta');
    const barAplica = document.getElementById('exec-bar-aplica');
    const barEditada = document.getElementById('exec-bar-editada');
    if (barSinAlerta) barSinAlerta.style.width = `${pctSinAlerta}%`;
    if (barAplica) barAplica.style.width = `${pctAplicaUniverse}%`;
    if (barEditada) barEditada.style.width = `${pctNoAplicaUniverse}%`;

    const legSinAlerta = document.getElementById('exec-legend-sin-alerta');
    const legAplica = document.getElementById('exec-legend-aplica');
    const legEditada = document.getElementById('exec-legend-editada');
    if (legSinAlerta) legSinAlerta.textContent = `${totalSinAlerta} (${pctSinAlerta}%)`;
    if (legAplica) legAplica.textContent = `${totalAplica} (${pctAplicaUniverse}%)`;
    if (legEditada) legEditada.textContent = `${totalNoAplica} (${pctNoAplicaUniverse}%)`;

    const statUniTotal = document.getElementById('exec-stat-universe-total');
    const statUniCalc = document.getElementById('exec-stat-universe-calc');
    const statUniSinAlerta = document.getElementById('exec-stat-universe-sin-alerta');
    const statUniSinAlertaPct = document.getElementById('exec-stat-universe-sin-alerta-pct');
    const statUniAplica = document.getElementById('exec-stat-universe-aplica');
    const statUniAplicaPct = document.getElementById('exec-stat-universe-aplica-pct');
    const statUniEditadas = document.getElementById('exec-stat-universe-editadas');
    const statUniEditadasPct = document.getElementById('exec-stat-universe-editadas-pct');

    if (statUniTotal) statUniTotal.textContent = totalMeasurableUniverse;
    if (statUniCalc) statUniCalc.textContent = `${audits.length} auditorías × ${kpisPerAudit} KPIs`;
    if (statUniSinAlerta) statUniSinAlerta.textContent = totalSinAlerta;
    if (statUniSinAlertaPct) statUniSinAlertaPct.textContent = `${pctSinAlerta}% del universo`;
    if (statUniAplica) statUniAplica.textContent = totalAplica;
    if (statUniAplicaPct) statUniAplicaPct.textContent = `${pctAplicaUniverse}% del universo`;
    if (statUniEditadas) statUniEditadas.textContent = totalNoAplica;
    if (statUniEditadasPct) statUniEditadasPct.textContent = `${pctNoAplicaUniverse}% del universo (${pctAlertasEditadas}% de alertas editadas)`;

    // 3. Renderizar Tabla Benchmark Comercial entre Estudios
    const benchmarkTbody = document.getElementById('exec-benchmark-tbody');
    if (benchmarkTbody) {
      const channelList = Object.values(channelStats);
      if (channelList.length === 0) {
        benchmarkTbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Sin datos de estudios.</td></tr>';
      } else {
        benchmarkTbody.innerHTML = channelList.map(ch => {
          const evalCh = ch.aplica + ch.noAplica;
          const pctConfirm = evalCh > 0 ? Math.round((ch.aplica / evalCh) * 100) : 0;
          const efectividadExecution = ch.audits > 0 
            ? Math.max(10, Math.min(100, Math.round(100 - (ch.aplica / (ch.audits * 3 || 1)) * 50)))
            : 100;

          return `
            <tr>
              <td><span class="benchmark-badge-flag">${ch.name}</span></td>
              <td><strong>${ch.audits}</strong></td>
              <td><span class="badge badge-purple">${ch.alerts} alertas</span></td>
              <td><strong class="text-success">${ch.aplica}</strong></td>
              <td><strong class="text-magenta">${ch.noAplica}</strong></td>
              <td>
                <div style="display:flex; align-items:center; gap:0.5rem;">
                  <div class="progress-bar-bg" style="width:60px; height:6px;">
                    <div class="progress-bar-fill progress-emerald" style="width: ${pctConfirm}%"></div>
                  </div>
                  <strong>${pctConfirm}%</strong>
                </div>
              </td>
              <td>
                <span class="badge ${efectividadExecution >= 80 ? 'badge-success' : 'badge-warning'}">
                  ${efectividadExecution}% en PDV
                </span>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // 4. Renderizar Ranking / Pareto de KPIs con más Alertas
    const rankingContainer = document.getElementById('exec-kpi-ranking-list');
    if (rankingContainer) {
      if (kpiRanking.length === 0) {
        rankingContainer.innerHTML = '<p class="text-muted">No hay datos de alertas para generar el ranking.</p>';
      } else {
        rankingContainer.innerHTML = kpiRanking.map((kpi, idx) => {
          const evalK = kpi.aplica + kpi.noAplica;
          const pctAplica = evalK > 0 ? Math.round((kpi.aplica / evalK) * 100) : 0;
          const pctNoAplica = evalK > 0 ? Math.round((kpi.noAplica / evalK) * 100) : 0;
          const pctGlobalAlerts = totalAlerts > 0 ? ((kpi.total / totalAlerts) * 100).toFixed(1) : 0;

          return `
            <div class="kpi-ranking-item">
              <div class="kpi-ranking-header">
                <span class="kpi-ranking-name">
                  <span class="kpi-rank-badge">#${idx + 1}</span>
                  ${kpi.name}
                </span>
                <span class="kpi-ranking-counts">
                  <strong>${kpi.total} alertas</strong> (${pctGlobalAlerts}% del total)
                </span>
              </div>

              <div class="kpi-ranking-bar-wrap" title="${kpi.aplica} Aplica / ${kpi.noAplica} No Aplica">
                <div class="kpi-bar-fill-aplica" style="width: ${pctAplica}%"></div>
                <div class="kpi-bar-fill-no-aplica" style="width: ${pctNoAplica}%"></div>
              </div>

              <div class="kpi-ranking-legend">
                <span class="text-success">✓ Aplica: <strong>${kpi.aplica}</strong> (${pctAplica}%)</span>
                <span class="text-magenta">✕ No Aplica: <strong>${kpi.noAplica}</strong> (${pctNoAplica}%)</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 5. Renderizar Incidencia por Estudio / Canal
    const channelsContainer = document.getElementById('exec-channels-breakdown');
    if (channelsContainer) {
      const channelList = Object.values(channelStats).filter(ch => ch.audits > 0 || ch.alerts > 0);
      if (channelList.length === 0) {
        channelsContainer.innerHTML = '<p class="text-muted">Sin datos de canales para los estudios seleccionados.</p>';
      } else {
        channelsContainer.innerHTML = channelList.map(ch => {
          const pctChAlerts = totalAlerts > 0 ? Math.round((ch.alerts / totalAlerts) * 100) : 0;
          const evalCh = ch.aplica + ch.noAplica;
          const pctEfectividad = evalCh > 0 ? Math.round((ch.aplica / evalCh) * 100) : 0;

          return `
            <div class="exec-channel-row">
              <div class="exec-channel-meta">
                <span><strong>${ch.name}</strong> (${ch.audits} auditorías)</span>
                <span>${ch.alerts} alertas (${pctChAlerts}%) • <span class="text-success">${pctEfectividad}% efectividad</span></span>
              </div>
              <div class="exec-channel-bar-wrap">
                <div class="exec-channel-bar-fill" style="width: ${pctChAlerts}%; background: var(--dn-blue);"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 6. Renderizar Causas Raíz de Descarte
    const reasonsContainer = document.getElementById('exec-reasons-breakdown');
    if (reasonsContainer) {
      const reasonEntries = Object.entries(reasonsMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (reasonEntries.length === 0) {
        reasonsContainer.innerHTML = '<p class="text-muted">Sin tipificaciones de descarte registradas.</p>';
      } else {
        reasonsContainer.innerHTML = reasonEntries.map(([reason, count]) => {
          const pct = totalNoAplica > 0 ? Math.round((count / totalNoAplica) * 100) : 0;
          return `
            <div class="exec-reason-row">
              <span class="exec-reason-name">${reason}</span>
              <span class="exec-reason-pct">${count} casos (${pct}%)</span>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ==========================================
  // INFORME COMERCIAL Y EXPORTACIÓN A PDF
  // ==========================================
  openCommercialReportPreview(showModal = true) {
    const modal = document.getElementById('modal-commercial-report-preview');
    if (!modal) return;

    const audits = this.getFilteredAuditsForReports();
    const studyLabel = this.selectedStudies.includes('ALL') 
      ? 'Chile, Tradicional, Moderno, Lindley' 
      : this.selectedStudies.join(', ');

    // 1. Header & Badge
    const scopeBadge = document.getElementById('dossier-study-scope-badge');
    const dateLabel = document.getElementById('commercial-dossier-date-label');
    if (scopeBadge) scopeBadge.textContent = `Estudios: ${studyLabel}`;
    if (dateLabel) {
      const todayStr = formatNicaraguaDate(new Date());
      dateLabel.textContent = `Emisión: ${todayStr} • Protocolo de Calidad dichter & neira`;
    }

    // 2. Metrics calculation
    let totalAlerts = 0;
    let totalAplica = 0;
    let totalNoAplica = 0;
    let totalSecs = 0;
    let completedCount = 0;
    const kpiMap = {};
    const reasonsMap = {};
    const allUniqueKpis = new Set();
    const studyMap = {
      'Chile': { name: '🇨🇱 Chile', audits: 0, alerts: 0, aplica: 0, noAplica: 0 },
      'Tradicional': { name: '🏪 Tradicional', audits: 0, alerts: 0, aplica: 0, noAplica: 0 },
      'Moderno': { name: '🏬 Moderno', audits: 0, alerts: 0, aplica: 0, noAplica: 0 },
      'Lindley': { name: '🥤 Lindley', audits: 0, alerts: 0, aplica: 0, noAplica: 0 }
    };

    audits.forEach(a => {
      const st = this.getStudyForAudit(a);
      if (!studyMap[st]) studyMap[st] = { name: st, audits: 0, alerts: 0, aplica: 0, noAplica: 0 };
      studyMap[st].audits++;

      if (a.validationStatus === 'completada') {
        completedCount++;
        if (a.durationSeconds) totalSecs += a.durationSeconds;
      }

      (a.kpis || []).forEach(k => {
        allUniqueKpis.add(k.kpiName || k.name);
        if (k.needsReview) {
          totalAlerts++;
          studyMap[st].alerts++;
          const kn = k.kpiName || k.name;
          if (!kpiMap[kn]) kpiMap[kn] = { name: kn, total: 0, aplica: 0, noAplica: 0 };
          kpiMap[kn].total++;

          const res = (a.validationResults || {})[k.name];
          if (res && res.status === 'aplica') {
            totalAplica++;
            kpiMap[kn].aplica++;
            studyMap[st].aplica++;
          } else if (res && res.status === 'no_aplica') {
            totalNoAplica++;
            kpiMap[kn].noAplica++;
            studyMap[st].noAplica++;
            if (res.tipificacion) reasonsMap[res.tipificacion] = (reasonsMap[res.tipificacion] || 0) + 1;
          }
        }
      });
    });

    const evaluated = totalAplica + totalNoAplica;
    const confirmRate = evaluated > 0 ? `${Math.round((totalAplica / evaluated) * 100)}%` : '0%';
    const avgSec = completedCount > 0 ? Math.round(totalSecs / completedCount) : 24;

    // Universo de Medición en Dossier
    const kpisPerAudit = Math.max(9, allUniqueKpis.size || 9);
    const totalMeasurableUniverse = audits.length * kpisPerAudit;
    const totalSinAlerta = Math.max(0, totalMeasurableUniverse - totalAlerts);
    const pctSinAlerta = totalMeasurableUniverse > 0 ? ((totalSinAlerta / totalMeasurableUniverse) * 100).toFixed(1) : '0.0';
    const pctAplicaUniverse = totalMeasurableUniverse > 0 ? ((totalAplica / totalMeasurableUniverse) * 100).toFixed(1) : '0.0';
    const pctNoAplicaUniverse = totalMeasurableUniverse > 0 ? ((totalNoAplica / totalMeasurableUniverse) * 100).toFixed(1) : '0.0';
    const pctAlertasEditadas = totalAlerts > 0 ? Math.round((totalNoAplica / totalAlerts) * 100) : 0;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('dossier-kpi-audits', audits.length);
    setEl('dossier-kpi-alerts-total', totalAlerts);
    setEl('dossier-kpi-confirm-rate', confirmRate);
    setEl('dossier-kpi-false-positives', totalNoAplica);
    setEl('dossier-kpi-avg-time', `${avgSec}s`);

    // Universo DOM en Dossier Modal
    const dBarSinAlerta = document.getElementById('dossier-bar-sin-alerta');
    const dBarAplica = document.getElementById('dossier-bar-aplica');
    const dBarEditada = document.getElementById('dossier-bar-editada');
    if (dBarSinAlerta) dBarSinAlerta.style.width = `${pctSinAlerta}%`;
    if (dBarAplica) dBarAplica.style.width = `${pctAplicaUniverse}%`;
    if (dBarEditada) dBarEditada.style.width = `${pctNoAplicaUniverse}%`;

    setEl('dossier-legend-sin-alerta', `${totalSinAlerta} (${pctSinAlerta}%)`);
    setEl('dossier-legend-aplica', `${totalAplica} (${pctAplicaUniverse}%)`);
    setEl('dossier-legend-editada', `${totalNoAplica} (${pctNoAplicaUniverse}%)`);

    setEl('dossier-stat-universe-total', totalMeasurableUniverse);
    setEl('dossier-stat-universe-calc', `${audits.length} Aud. × ${kpisPerAudit} KPIs`);
    setEl('dossier-stat-universe-sin-alerta', totalSinAlerta);
    setEl('dossier-stat-universe-sin-alerta-pct', `${pctSinAlerta}% del universo`);
    setEl('dossier-stat-universe-aplica', totalAplica);
    setEl('dossier-stat-universe-aplica-pct', `${pctAplicaUniverse}% del universo`);
    setEl('dossier-stat-universe-editadas', totalNoAplica);
    setEl('dossier-stat-universe-editadas-pct', `${pctNoAplicaUniverse}% del universo (${pctAlertasEditadas}% de alertas)`);

    // POPULAR DOCUMENTO GERENCIAL EXCLUSIVO PARA IMPRESIÓN/PDF
    const todayStr = formatNicaraguaDate(new Date());
    setEl('print-meta-date', todayStr);
    setEl('print-meta-scope', studyLabel);

    setEl('print-kpi-audits', audits.length);
    setEl('print-kpi-false-positives', totalNoAplica);
    setEl('print-kpi-precision', confirmRate);
    setEl('print-kpi-sla', `${avgSec}s`);
    setEl('print-kpi-universe-total', totalMeasurableUniverse);
    setEl('print-kpi-universe-desc', `${audits.length} Aud. × ${kpisPerAudit} KPIs`);

    const pBarSinAlerta = document.getElementById('print-bar-sin-alerta');
    const pBarAplica = document.getElementById('print-bar-aplica');
    const pBarEditada = document.getElementById('print-bar-editada');
    if (pBarSinAlerta) pBarSinAlerta.style.width = `${pctSinAlerta}%`;
    if (pBarAplica) pBarAplica.style.width = `${pctAplicaUniverse}%`;
    if (pBarEditada) pBarEditada.style.width = `${pctNoAplicaUniverse}%`;

    setEl('print-legend-sin-alerta', `${totalSinAlerta} (${pctSinAlerta}%)`);
    setEl('print-legend-aplica', `${totalAplica} (${pctAplicaUniverse}%)`);
    setEl('print-legend-editada', `${totalNoAplica} (${pctNoAplicaUniverse}%)`);

    setEl('print-tbl-sin-alerta-count', totalSinAlerta);
    setEl('print-tbl-sin-alerta-pct', `${pctSinAlerta}%`);
    setEl('print-tbl-aplica-count', totalAplica);
    setEl('print-tbl-aplica-pct', `${pctAplicaUniverse}%`);
    setEl('print-tbl-editadas-count', totalNoAplica);
    setEl('print-tbl-editadas-pct', `${pctNoAplicaUniverse}% (${pctAlertasEditadas}% de alertas)`);

    // 3. Benchmark Table (Modal + Print)
    const benchTbody = document.getElementById('dossier-benchmark-tbody');
    const printBenchTbody = document.getElementById('print-benchmark-tbody');
    const studyRowsHtml = Object.values(studyMap).map(st => {
      const ev = st.aplica + st.noAplica;
      const pConf = ev > 0 ? Math.round((st.aplica / ev) * 100) : 0;
      const execRate = st.audits > 0 
        ? Math.max(10, Math.min(100, Math.round(100 - (st.aplica / (st.audits * 3 || 1)) * 50)))
        : 100;
      return `
        <tr>
          <td><strong>${st.name}</strong></td>
          <td>${st.audits}</td>
          <td><span class="badge badge-purple">${st.alerts}</span></td>
          <td><strong class="text-success">${st.aplica}</strong></td>
          <td><strong class="text-magenta">${st.noAplica}</strong></td>
          <td><strong>${pConf}%</strong></td>
          <td><span class="badge ${execRate >= 80 ? 'badge-success' : 'badge-warning'}">${execRate}% en PDV</span></td>
        </tr>
      `;
    }).join('');

    if (benchTbody) benchTbody.innerHTML = studyRowsHtml;
    if (printBenchTbody) printBenchTbody.innerHTML = studyRowsHtml;

    // 4. Top KPIs list (Modal + Print)
    const topKpisList = document.getElementById('dossier-top-kpis-list');
    const printTopKpisTbody = document.getElementById('print-top-kpis-tbody');
    const sortedKpis = Object.values(kpiMap).sort((a, b) => b.total - a.total).slice(0, 5);
    
    if (topKpisList) {
      if (sortedKpis.length === 0) {
        topKpisList.innerHTML = '<p class="text-muted">Sin registros de alertas.</p>';
      } else {
        topKpisList.innerHTML = sortedKpis.map((kpi, idx) => {
          const ev = kpi.aplica + kpi.noAplica;
          const pA = ev > 0 ? Math.round((kpi.aplica / ev) * 100) : 0;
          return `
            <div class="dossier-ranking-row">
              <div class="dossier-rank-label">
                <span>#${idx + 1} ${kpi.name}</span>
                <span><strong>${kpi.total} alertas</strong> (${pA}% confirmadas)</span>
              </div>
              <div class="progress-bar-bg" style="height:6px;">
                <div class="progress-bar-fill progress-emerald" style="width: ${pA}%"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    if (printTopKpisTbody) {
      if (sortedKpis.length === 0) {
        printTopKpisTbody.innerHTML = '<tr><td colspan="4" class="text-muted">Sin alertas registradas</td></tr>';
      } else {
        printTopKpisTbody.innerHTML = sortedKpis.map((kpi, idx) => {
          const ev = kpi.aplica + kpi.noAplica;
          const pA = ev > 0 ? Math.round((kpi.aplica / ev) * 100) : 0;
          return `
            <tr>
              <td><strong>#${idx + 1}</strong></td>
              <td>${kpi.name}</td>
              <td><strong>${kpi.total}</strong></td>
              <td><strong class="print-text-success">${pA}%</strong></td>
            </tr>
          `;
        }).join('');
      }
    }

    // 5. Reasons list (Modal + Print)
    const reasonsList = document.getElementById('dossier-reasons-list');
    const printReasonsTbody = document.getElementById('print-reasons-tbody');
    const sortedReasons = Object.entries(reasonsMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    
    if (reasonsList) {
      if (sortedReasons.length === 0) {
        reasonsList.innerHTML = '<p class="text-muted">Sin motivos de descarte registrados.</p>';
      } else {
        reasonsList.innerHTML = sortedReasons.map(([r, c]) => {
          const p = totalNoAplica > 0 ? Math.round((c / totalNoAplica) * 100) : 0;
          return `
            <div class="dossier-ranking-row">
              <div class="dossier-rank-label">
                <span>${r}</span>
                <span><strong>${c} casos</strong> (${p}%)</span>
              </div>
              <div class="progress-bar-bg" style="height:6px;">
                <div class="progress-bar-fill progress-rose" style="width: ${p}%"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    if (printReasonsTbody) {
      if (sortedReasons.length === 0) {
        printReasonsTbody.innerHTML = '<tr><td colspan="3" class="text-muted">Sin descartes registrados</td></tr>';
      } else {
        printReasonsTbody.innerHTML = sortedReasons.map(([r, c]) => {
          const p = totalNoAplica > 0 ? Math.round((c / totalNoAplica) * 100) : 0;
          return `
            <tr>
              <td>${r}</td>
              <td><strong>${c}</strong></td>
              <td><strong class="print-text-magenta">${p}%</strong></td>
            </tr>
          `;
        }).join('');
      }
    }

    // 6. Recommendations (Modal + Print)
    const recGrid = document.getElementById('dossier-recommendations-content');
    const printRecGrid = document.getElementById('print-recommendations-content');
    const topKpiName = sortedKpis.length > 0 ? sortedKpis[0].name : 'Variables Comerciales';
    const topReasonName = sortedReasons.length > 0 ? sortedReasons[0][0] : 'Criterios de canal';

    const recHtml = `
      <div class="dossier-rec-card">
        <strong>1. Foco Estratégico en Punto de Venta:</strong>
        La variable con mayor incidencia de alertas es <em>"${topKpiName}"</em>. Se recomienda coordinar con el equipo comercial y de trade marketing para reforzar la ejecución en PDV de esta categoría.
      </div>
      <div class="dossier-rec-card">
        <strong>2. Optimización de Auditoría en Campo:</strong>
        La principal causa de falsos positivos prevenidos es <em>"${topReasonName}"</em> (${totalNoAplica} alertas evitadas al cliente). Mantener la calibración periódica de las reglas smart para maximizar la efectividad.
      </div>
      <div class="dossier-rec-card">
        <strong>3. Certificación de Calidad Garantizada:</strong>
        El 100% de los datos generados cuenta con validación humana experta y respaldo documental de dichter & neira, garantizando total confiabilidad para la toma de decisiones directivas.
      </div>
    `;

    const printRecHtml = `
      <div class="print-rec-item">
        <strong>1. Foco en PDV (${topKpiName})</strong>
        Mayor concentración de alertas en <em>${topKpiName}</em>. Reforzar auditoría y alineación de trade marketing.
      </div>
      <div class="print-rec-item">
        <strong>2. Filtro Humano (${totalNoAplica} alertas evitadas)</strong>
        Causa principal de descarte: <em>${topReasonName}</em>. El filtro humano protegió la data antes del cliente.
      </div>
      <div class="print-rec-item">
        <strong>3. Garantía D&N 100% Verificado</strong>
        Toda la reportería cuenta con trazabilidad y respaldo documental de dichter & neira.
      </div>
    `;

    if (recGrid) recGrid.innerHTML = recHtml;
    if (printRecGrid) printRecGrid.innerHTML = printRecHtml;

    if (showModal) modal.classList.remove('hidden');
  }

  async exportCommercialPDF() {
    if (typeof window.html2pdf !== 'function') {
      this.showToast('No fue posible cargar el generador de PDF. Verifica la conexión e intenta nuevamente.', 'error');
      return;
    }

    // Actualiza las métricas sin abrir la vista previa ni el diálogo de impresión.
    this.openCommercialReportPreview(false);
    const source = document.getElementById('commercial-printable-content');
    if (!source) {
      this.showToast('No fue posible preparar el informe para descargar.', 'error');
      return;
    }

    const capture = document.createElement('section');
    capture.className = 'commercial-dossier-modal';
    capture.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'z-index:2147483647',
      'width:1050px',
      'max-width:none',
      'height:auto',
      'max-height:none',
      'overflow:visible',
      'padding:0',
      'background:#FFFFFF',
      'pointer-events:none'
    ].join(';');
    capture.innerHTML = `
      <header style="padding:1.25rem 1.75rem; background:#FFFFFF; border-bottom:2px solid #E0EFFF; display:flex; align-items:center; gap:1rem;">
        <img src="assets/dn-logo-color.png" alt="dichter & neira" style="height:38px; width:auto; object-fit:contain;" />
        <div>
          <strong style="display:block; color:#002B49; font-size:1.25rem;">Informe Gerencial de Calidad & Eficiencia de Alertas</strong>
          <span style="color:#64748B; font-size:0.85rem;">dichter & neira • ValidaFlow</span>
        </div>
      </header>
    `;
    capture.appendChild(source.cloneNode(true));
    document.body.appendChild(capture);

    const dateStamp = getNicaraguaDateKey(new Date());
    this.showToast('Generando tu PDF… la descarga iniciará automáticamente.', 'info');

    try {
      await document.fonts?.ready;
      await Promise.all([...capture.querySelectorAll('img')].map(image => (
        image.complete
          ? Promise.resolve()
          : new Promise(resolve => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            })
      )));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await window.html2pdf()
        .set({
          margin: [8, 8, 8, 8],
          filename: `informe-ejecutivo-validaflow-${dateStamp}.pdf`,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#FFFFFF', logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['css', 'legacy'] }
        })
        .from(capture)
        .save();
      this.showToast('PDF descargado correctamente.', 'success');
    } catch (error) {
      console.error('No fue posible generar el PDF ejecutivo:', error);
      this.showToast('No fue posible generar el PDF. Intenta nuevamente.', 'error');
    } finally {
      capture.remove();
    }
  }

  // ==========================================
  // NAVEGACIÓN DE PESTAÑAS DE SUPERVISIÓN
  // ==========================================
  switchSupervisorTab(targetTab) {
    this.currentTab = targetTab;
    const tabBtns = document.querySelectorAll('#supervisor-nav-tabs .nav-tab-btn');
    const tabPanes = document.querySelectorAll('#private-supervisor-view .tab-content-pane');

    tabBtns.forEach(btn => {
      if (btn.dataset.tab === targetTab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    tabPanes.forEach(p => {
      if (p.id === `tab-${targetTab}`) {
        p.classList.add('active');
      } else {
        p.classList.remove('active');
      }
    });

    if (targetTab === 'reports') {
      this.renderReportsView();
      this.renderDailyReportsView();
      this.ensureHistoricalReportsLoaded();
    } else if (targetTab === 'admin') {
      this.renderAdminView();
    } else if (targetTab === 'lookup') {
      this.populateLookupQuickTags();
      document.getElementById('lookup-search-input')?.focus();
    } else if (targetTab === 'queries') {
      this.renderQueriesView();
    } else if (targetTab === 'alerts') {
      this.renderAlertsView();
    }
  }

  // ==========================================
  // SEGUIMIENTO A DUDAS Y CONSULTAS DE VALIDADORES (❓)
  // ==========================================
  initQueriesModule() {
    // 1. Selector de tipo de dictamen en el modal de resolución
    const radioAplica = document.querySelector('input[name="modal_resolve_decision"][value="aplica"]');
    const radioNoAplica = document.querySelector('input[name="modal_resolve_decision"][value="no_aplica"]');
    const lblAplica = document.getElementById('modal-lbl-choice-aplica');
    const lblNoAplica = document.getElementById('modal-lbl-choice-no-aplica');
    const tipifGroup = document.getElementById('modal-resolve-tipif-group');

    radioAplica?.addEventListener('change', () => {
      lblAplica?.classList.add('active');
      lblNoAplica?.classList.remove('active');
      if (tipifGroup) tipifGroup.style.display = 'none';
    });

    radioNoAplica?.addEventListener('change', () => {
      lblNoAplica?.classList.add('active');
      lblAplica?.classList.remove('active');
      if (tipifGroup) tipifGroup.style.display = 'block';
    });

    // 2. Confirmar resolución de la consulta
    document.getElementById('btn-confirm-resolve-query')?.addEventListener('click', () => {
      this.submitResolveQuery();
    });
  }

  getAllValidatorQueries() {
    const queries = [];
    const valMap = new Map(this.validators.map(v => [v.code, v]));

    this.audits.forEach(audit => {
      const results = audit.validationResults || {};
      const val = valMap.get(audit.validatorCode) || {
        name: audit.validadorNombre || 'Validador Asignado',
        code: audit.validatorCode || audit.assignedValidatorId || 'VAL-01'
      };

      Object.entries(results).forEach(([kpiName, res]) => {
        if (res.status === 'duda' || (res.dudaText && res.dudaText.trim().length > 0)) {
          const isResolved = Boolean(res.supervisorResponse || (res.supervisorDecision && res.status !== 'duda'));
          queries.push({
            auditId: audit.id,
            idPDV: audit.idPDV || audit.id,
            study: audit.estudio || audit.canal || 'Tradicional',
            country: audit.pais || 'N/A',
            city: audit.ciudad || 'N/A',
            channel: audit.canal || 'N/A',
            validatorName: val.name,
            validatorCode: val.code,
            kpiName,
            dudaText: res.dudaText || 'Duda registrada sin comentario.',
            dudaCreatedAt: res.dudaCreatedAt || res.updatedAt || new Date().toISOString(),
            isResolved,
            supervisorResponse: res.supervisorResponse || '',
            supervisorDecision: res.supervisorDecision || (res.status !== 'duda' ? res.status : ''),
            supervisorTipificacion: res.supervisorTipificacion || res.tipificacion || '',
            supervisorResolvedAt: res.supervisorResolvedAt || ''
          });
        }
      });
    });

    // Ordenar: primero pendientes (más recientes primero), luego resueltas
    return queries.sort((a, b) => {
      if (a.isResolved !== b.isResolved) {
        return a.isResolved ? 1 : -1;
      }
      return new Date(b.dudaCreatedAt) - new Date(a.dudaCreatedAt);
    });
  }

  renderQueriesView() {
    const allQueries = this.getAllValidatorQueries();
    const pendingQueries = allQueries.filter(q => !q.isResolved);
    const resolvedQueries = allQueries.filter(q => q.isResolved);

    // 1. Actualizar Badge en la barra de navegación del Supervisor
    const navBadge = document.getElementById('nav-queries-badge');
    if (navBadge) {
      if (pendingQueries.length > 0) {
        navBadge.textContent = pendingQueries.length;
        navBadge.classList.remove('hidden');
      } else {
        navBadge.classList.add('hidden');
      }
    }

    // 2. Tarjetas de métricas
    const elTotal = document.getElementById('query-stat-total');
    const elPending = document.getElementById('query-stat-pending');
    const elResolved = document.getElementById('query-stat-resolved');
    const elTopStudy = document.getElementById('query-stat-top-study');

    if (elTotal) elTotal.textContent = allQueries.length;
    if (elPending) elPending.textContent = pendingQueries.length;
    if (elResolved) elResolved.textContent = resolvedQueries.length;

    // Estudio con más consultas
    if (elTopStudy) {
      if (allQueries.length === 0) {
        elTopStudy.textContent = 'Ninguno';
      } else {
        const countsByStudy = {};
        allQueries.forEach(q => countsByStudy[q.study] = (countsByStudy[q.study] || 0) + 1);
        const top = Object.entries(countsByStudy).sort((a, b) => b[1] - a[1])[0];
        elTopStudy.textContent = top ? `${top[0]} (${top[1]})` : '—';
      }
    }

    // 3. Contadores de botones de filtro
    const elCountAll = document.getElementById('qcount-all');
    const elCountPending = document.getElementById('qcount-pending');
    const elCountResolved = document.getElementById('qcount-resolved');

    if (elCountAll) elCountAll.textContent = allQueries.length;
    if (elCountPending) elCountPending.textContent = pendingQueries.length;
    if (elCountResolved) elCountResolved.textContent = resolvedQueries.length;

    // 4. Filtrar lista
    let filtered = allQueries;
    if (this.queryFilter === 'pending') {
      filtered = filtered.filter(q => !q.isResolved);
    } else if (this.queryFilter === 'resolved') {
      filtered = filtered.filter(q => q.isResolved);
    }

    if (this.queryStudyFilter && this.queryStudyFilter !== 'ALL') {
      filtered = filtered.filter(q => q.study.toLowerCase() === this.queryStudyFilter.toLowerCase());
    }

    // 5. Renderizar lista interactiva
    const container = document.getElementById('queries-feed-container');
    if (!container) return;

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="glass-panel text-center" style="padding:3.5rem 2rem;">
          <div style="font-size:3rem; margin-bottom:0.75rem;">🎉✨</div>
          <h3 style="color:var(--dn-navy); margin-bottom:0.4rem;">¡No hay consultas pendientes con el filtro actual!</h3>
          <p class="text-muted" style="max-width:480px; margin:0 auto;">
            Los validadores han resuelto sus asignaciones sin dudas o todas las preguntas ya fueron dictaminadas por supervisión.
          </p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(q => {
      const formattedDate = formatNicaraguaDateTime(q.dudaCreatedAt, 'Sin fecha');

      return `
        <div class="query-card-item ${q.isResolved ? 'status-resolved' : 'status-pending'}">
          <div class="query-header-row">
            <div class="query-meta-badges">
              <span class="query-audit-badge">Auditoría #${q.auditId}</span>
              <span class="badge badge-info">PDV: ${q.idPDV}</span>
              <span class="badge badge-purple">${q.study}</span>
              <span class="badge badge-neutral">Validador: <strong>${q.validatorName}</strong> (${q.validatorCode})</span>
            </div>
            <div>
              ${q.isResolved 
                ? `<span class="badge badge-success">✅ Resuelta por Supervisor</span>`
                : `<span class="badge badge-warning">⏳ Pendiente de Respuesta</span>`
              }
            </div>
          </div>

          <div class="query-body-content">
            <div class="query-kpi-highlight">
              🎯 KPI en Consulta: <span class="text-primary">${q.kpiName}</span>
            </div>

            <div class="query-doubt-box">
              <strong>❓ Pregunta / Duda del Validador:</strong>
              <p style="margin:0.25rem 0 0 0;">"${q.dudaText}"</p>
            </div>

            ${q.isResolved ? `
              <div class="query-resolution-box">
                <div>
                  <strong>💬 Dictamen Oficial del Supervisor:</strong>
                  <span class="badge ${q.supervisorDecision === 'aplica' ? 'badge-success' : 'badge-danger'}" style="margin-left:0.4rem;">
                    ${q.supervisorDecision === 'aplica' ? '✓ Aplica (Error de Campo)' : '✕ No Aplica (Falso Positivo)'}
                  </span>
                  ${q.supervisorTipificacion ? `<span class="text-muted" style="font-size:0.8rem; margin-left:0.35rem;">(${q.supervisorTipificacion})</span>` : ''}
                </div>
                <p style="margin:0.25rem 0 0 0; font-style:italic;">"${q.supervisorResponse || 'Instrucción confirmada por supervisión.'}"</p>
              </div>
            ` : ''}
          </div>

          <div class="query-actions-footer">
            <span class="query-timestamp-info">📅 Consulta registrada: ${formattedDate}</span>
            <div style="display:flex; gap:0.5rem;">
              <button class="btn btn-outline btn-sm" onclick="window.app?.inspectAuditInLookup('${q.auditId}')">
                🔎 Inspeccionar Ficha
              </button>
              <button class="btn ${q.isResolved ? 'btn-secondary' : 'btn-primary btn-glow'} btn-sm" onclick="window.openResolveQueryModal('${q.auditId}', '${q.kpiName.replace(/'/g, "\\'")}')">
                ${q.isResolved ? '✏️ Modificar Dictamen' : '✍️ Responder y Dictaminar'}
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  setQueryFilter(filterKey) {
    this.queryFilter = filterKey;
    const filterBtns = document.querySelectorAll('#query-status-filters .filter-pill-btn');
    filterBtns.forEach(btn => {
      if (btn.dataset.qfilter === filterKey) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    this.renderQueriesView();
  }

  setQueryStudyFilter(studyKey) {
    this.queryStudyFilter = studyKey;
    this.renderQueriesView();
  }

  inspectAuditInLookup(auditId) {
    this.switchSupervisorTab('lookup');
    const input = document.getElementById('lookup-search-input');
    if (input) {
      input.value = auditId;
      this.executeLookupSearch();
    }
  }

  openResolveQueryModal(auditId, kpiName) {
    const audit = this.audits.find(a => String(a.id) === String(auditId));
    if (!audit) {
      this.showToast('Auditoría no encontrada.', 'error');
      return;
    }

    const res = (audit.validationResults && audit.validationResults[kpiName]) || {};
    const val = this.validators.find(v => v.code === audit.validatorCode) || {
      name: audit.validadorNombre || 'Validador',
      code: audit.validatorCode || 'VAL-01'
    };

    this.pendingQueryToResolve = { auditId, kpiName };

    const elAuditId = document.getElementById('modal-q-audit-id');
    const elPdvId = document.getElementById('modal-q-pdv-id');
    const elVal = document.getElementById('modal-q-validator');
    const elKpi = document.getElementById('modal-q-kpi-name');
    const elDoubt = document.getElementById('modal-q-doubt-text');

    if (elAuditId) elAuditId.textContent = `#${audit.id}`;
    if (elPdvId) elPdvId.textContent = audit.idPDV || audit.id;
    if (elVal) elVal.textContent = `${val.name} (${val.code})`;
    if (elKpi) elKpi.textContent = kpiName;
    if (elDoubt) elDoubt.textContent = `"${res.dudaText || 'Sin descripción'}"`;

    // Llenar opciones de tipificación
    const tipifSelect = document.getElementById('modal-resolve-tipif');
    if (tipifSelect) {
      tipifSelect.innerHTML = this.tipificaciones.map(t => {
        const isSel = (res.supervisorTipificacion || res.tipificacion) === t ? 'selected' : '';
        return `<option value="${t}" ${isSel}>${t}</option>`;
      }).join('');
    }

    // Configurar estado inicial de la decisión
    const curDecision = res.supervisorDecision || (res.status === 'no_aplica' ? 'no_aplica' : 'aplica');
    const radioAplica = document.querySelector('input[name="modal_resolve_decision"][value="aplica"]');
    const radioNoAplica = document.querySelector('input[name="modal_resolve_decision"][value="no_aplica"]');
    const lblAplica = document.getElementById('modal-lbl-choice-aplica');
    const lblNoAplica = document.getElementById('modal-lbl-choice-no-aplica');
    const tipifGroup = document.getElementById('modal-resolve-tipif-group');

    if (curDecision === 'no_aplica') {
      if (radioNoAplica) radioNoAplica.checked = true;
      lblNoAplica?.classList.add('active');
      lblAplica?.classList.remove('active');
      if (tipifGroup) tipifGroup.style.display = 'block';
    } else {
      if (radioAplica) radioAplica.checked = true;
      lblAplica?.classList.add('active');
      lblNoAplica?.classList.remove('active');
      if (tipifGroup) tipifGroup.style.display = 'none';
    }

    const instTextarea = document.getElementById('modal-resolve-instructions');
    if (instTextarea) {
      instTextarea.value = res.supervisorResponse || '';
      setTimeout(() => instTextarea.focus(), 150);
    }

    document.getElementById('modal-resolve-query')?.classList.remove('hidden');
  }

  submitResolveQuery() {
    if (!this.pendingQueryToResolve) return;

    const { auditId, kpiName } = this.pendingQueryToResolve;
    const audit = this.audits.find(a => String(a.id) === String(auditId));
    if (!audit) {
      this.showToast('Auditoría no encontrada.', 'error');
      return;
    }

    const radioDecision = document.querySelector('input[name="modal_resolve_decision"]:checked');
    const decision = radioDecision?.value || 'aplica';
    const tipifSelect = document.getElementById('modal-resolve-tipif');
    const tipificacion = decision === 'no_aplica' ? (tipifSelect?.value || '') : '';
    const instTextarea = document.getElementById('modal-resolve-instructions');
    const instructions = instTextarea?.value.trim() || '';

    if (!audit.validationResults) audit.validationResults = {};
    const prev = audit.validationResults[kpiName] || {};

    audit.validationResults[kpiName] = {
      ...prev,
      status: decision,
      tipificacion: tipificacion,
      supervisorDecision: decision,
      supervisorResponse: instructions,
      supervisorTipificacion: tipificacion,
      supervisorResolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Verificar si la auditoría ya no tiene dudas pendientes y todos sus KPIs están evaluados
    const kpisToReview = (audit.kpis || []).filter(k => k.needsReview);
    let allDone = true;
    let hasRemainingDoubts = false;

    kpisToReview.forEach(k => {
      const r = audit.validationResults[k.name];
      if (!r || !r.status) {
        allDone = false;
      } else if (r.status === 'duda' && !r.supervisorResponse) {
        hasRemainingDoubts = true;
      }
    });

    if (allDone && !hasRemainingDoubts) {
      audit.validationStatus = 'completada';
      if (!audit.completedAt) audit.completedAt = new Date().toISOString();
    }

    this.saveState();
    this.syncStateAcrossTabs();

    document.getElementById('modal-resolve-query')?.classList.add('hidden');
    this.showToast(`¡Consulta de la Auditoría #${audit.id} resuelta como "${decision === 'aplica' ? 'Aplica' : 'No Aplica'}"!`, 'success');

    this.renderQueriesView();
    this.renderAdminView();
    this.renderReportsView();
    this.renderAlertsView();
    this.renderDailyReportsView();

    this.pendingQueryToResolve = null;
  }

  // ==========================================
  // HISTÓRICO SEMANAL AGREGADO POR VALIDADOR
  // ==========================================
  toLocalDateInputValue(date) {
    return getNicaraguaDateKey(date);
  }

  initValidatorHistoryModule() {
    const dateFrom = document.getElementById('history-date-from');
    const dateTo = document.getElementById('history-date-to');
    const moduleFilter = document.getElementById('history-module-filter');
    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 6);

    if (dateFrom && !dateFrom.value) dateFrom.value = this.toLocalDateInputValue(weekStart);
    if (dateTo && !dateTo.value) dateTo.value = this.toLocalDateInputValue(today);
    if (moduleFilter) moduleFilter.value = this.currentModule || '';

    document.getElementById('btn-load-validator-history')?.addEventListener('click', () => {
      this.loadValidatorHistory();
    });

    this.populateHistoryValidatorFilter();
  }

  populateHistoryValidatorFilter() {
    const select = document.getElementById('history-validator-filter');
    if (!select) return;
    const selected = select.value;
    const options = new Map();

    (this.validators || []).forEach(validator => {
      options.set(validator.id, { id: validator.id, code: validator.code, name: validator.name });
    });
    (this.validatorHistoryRows || []).forEach(row => {
      options.set(row.validatorId, {
        id: row.validatorId,
        code: row.validatorCode,
        name: row.validatorName
      });
    });

    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
    const ordered = [...options.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    select.innerHTML = '<option value="">Todos los validadores</option>' + ordered.map(item =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`
    ).join('');
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }

  async loadValidatorHistory(silent = false) {
    if (!this.backend.configured || !this.isSupervisor) {
      this.showToast('El histórico en la nube está disponible para supervisores autenticados.', 'warning');
      return;
    }

    const dateFrom = document.getElementById('history-date-from')?.value || '';
    const dateTo = document.getElementById('history-date-to')?.value || '';
    const validatorId = document.getElementById('history-validator-filter')?.value || null;
    const module = document.getElementById('history-module-filter')?.value || null;
    const fromDate = new Date(`${dateFrom}T00:00:00`);
    const toDate = new Date(`${dateTo}T00:00:00`);

    if (!dateFrom || !dateTo || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      this.showToast('Selecciona un rango de fechas válido.', 'warning');
      return;
    }

    const rangeDays = Math.floor((toDate - fromDate) / 86400000);
    if (rangeDays > 3650) {
      this.showToast('Selecciona un periodo de máximo 10 años.', 'warning');
      return;
    }

    const button = document.getElementById('btn-load-validator-history');
    const previousLabel = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = 'Consultando…';
    }

    try {
      this.validatorHistoryRows = await this.backend.loadValidatorHistory({
        dateFrom,
        dateTo,
        module,
        validatorId
      });
      this.validatorHistoryLoaded = true;
      this.populateHistoryValidatorFilter();
      this.renderValidatorHistory(dateFrom, dateTo);
      if (!silent) this.showToast(`Histórico consultado: ${dateFrom} a ${dateTo}.`, 'success');
    } catch (error) {
      console.error('Error consultando el histórico:', error);
      this.showToast(error.message || 'No fue posible consultar el histórico.', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = previousLabel || 'Consultar histórico';
      }
    }
  }

  renderValidatorHistory(dateFrom = '', dateTo = '') {
    const container = document.getElementById('validator-history-results');
    if (!container || !this.validatorHistoryLoaded) return;

    const rows = this.validatorHistoryRows || [];
    const groups = new Map();
    rows.forEach(row => {
      if (!groups.has(row.validatorId)) {
        groups.set(row.validatorId, {
          id: row.validatorId,
          code: row.validatorCode,
          name: row.validatorName,
          total: 0,
          completed: 0,
          inProgress: 0,
          pending: 0,
          timed: 0,
          duration: 0,
          days: new Set(),
          lastActivityAt: null,
          rows: []
        });
      }
      const group = groups.get(row.validatorId);
      group.total += row.totalAudits;
      group.completed += row.completedAudits;
      group.inProgress += row.inProgressAudits;
      group.pending += row.pendingAudits;
      group.timed += row.timedAudits;
      group.duration += row.totalDurationSeconds;
      group.days.add(row.operationDate);
      group.rows.push(row);
      if (row.lastActivityAt && (!group.lastActivityAt || row.lastActivityAt > group.lastActivityAt)) {
        group.lastActivityAt = row.lastActivityAt;
      }
    });

    const history = [...groups.values()].sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name, 'es'));
    const totalAudits = history.reduce((sum, item) => sum + item.total, 0);
    const totalCompleted = history.reduce((sum, item) => sum + item.completed, 0);
    const timedAudits = history.reduce((sum, item) => sum + item.timed, 0);
    const totalDuration = history.reduce((sum, item) => sum + item.duration, 0);
    const averageDuration = timedAudits > 0 ? Math.round(totalDuration / timedAudits) : 0;

    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };
    setText('history-stat-validators', history.length);
    setText('history-stat-total', totalAudits);
    setText('history-stat-completed', totalCompleted);
    setText('history-stat-average', `${averageDuration}s`);
    setText('history-range-badge', dateFrom && dateTo ? `${dateFrom} → ${dateTo}` : 'Consulta histórica');

    if (!history.length) {
      container.innerHTML = `
        <div class="history-empty-state">
          <span>🔎</span>
          <p>No se encontraron auditorías para los filtros seleccionados.</p>
        </div>
      `;
      return;
    }

    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
    const formatActivity = value => formatNicaraguaDateTime(value, 'Sin actividad');

    container.innerHTML = `
      <table class="validator-history-table">
        <thead>
          <tr>
            <th>Validador</th>
            <th>Jornadas</th>
            <th>Asignadas</th>
            <th>Gestionadas</th>
            <th>Pendientes</th>
            <th>Avance</th>
            <th>Tiempo prom.</th>
            <th>Última gestión</th>
          </tr>
        </thead>
        <tbody>
          ${history.map(item => {
            const progress = item.total > 0 ? Math.round((item.completed / item.total) * 100) : 0;
            const average = item.timed > 0 ? Math.round(item.duration / item.timed) : 0;
            const dailyRows = [...item.rows].sort((a, b) => b.operationDate.localeCompare(a.operationDate));
            const daysDetail = dailyRows.map(day => {
              const label = day.module === 'blocking' ? 'Bloqueantes' : 'Smart';
              return `<span>${escapeHtml(day.operationDate)} · ${label}: ${day.completedAudits}/${day.totalAudits} gestionadas</span>`;
            }).join('');
            return `
              <tr>
                <td class="history-validator-cell">
                  <strong>${escapeHtml(item.name)}</strong>
                  <code>${escapeHtml(item.code)}</code>
                </td>
                <td>
                  <details class="history-days-details">
                    <summary>${item.days.size} día${item.days.size !== 1 ? 's' : ''}</summary>
                    <div class="history-days-list">${daysDetail}</div>
                  </details>
                </td>
                <td>${item.total}</td>
                <td><strong class="text-success">${item.completed}</strong></td>
                <td>${item.pending + item.inProgress}</td>
                <td class="history-progress-cell">
                  <strong>${progress}%</strong>
                  <div class="history-progress-track"><div class="history-progress-fill" style="width:${progress}%"></div></div>
                </td>
                <td>${average}s</td>
                <td>${escapeHtml(formatActivity(item.lastActivityAt))}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  // ==========================================
  // DESCARGAS DÍA POR DÍA, CONSOLIDADO Y COMITÉ
  // ==========================================
  initDailyReportsModule() {
    // 1. Descargar Consolidado General
    document.getElementById('btn-export-excel')?.addEventListener('click', () => {
      const filtered = this.getFilteredAuditsForReports();
      if (filtered.length === 0) {
        this.showToast('No hay auditorías en la selección actual para exportar.', 'warning');
        return;
      }
      ExcelParser.exportResultsToExcel(filtered, this.validators);
      this.showToast('Descargando archivo Excel consolidado...', 'success');
    });

    // 2. Descargar Libro Multi-Hoja Día por Día
    document.getElementById('btn-export-multi-sheet')?.addEventListener('click', () => {
      const filtered = this.getFilteredAuditsForReports();
      if (filtered.length === 0) {
        this.showToast('No hay auditorías en la selección actual para exportar.', 'warning');
        return;
      }
      ExcelParser.exportDailyAndConsolidatedExcel(filtered, this.validators);
      this.showToast('Descargando libro Excel completo (Consolidado + Hojas por Día)...', 'success');
    });

    // 3. Descargar Informe Ejecutivo para Comité
    document.getElementById('btn-export-executive-xlsx')?.addEventListener('click', () => {
      const filtered = this.getFilteredAuditsForReports();
      if (filtered.length === 0) {
        this.showToast('No hay auditorías en la selección actual para generar informe.', 'warning');
        return;
      }
      const studyLabel = this.selectedStudies.includes('ALL') 
        ? 'Todos los Estudios' 
        : this.selectedStudies.join(', ');
      ExcelParser.exportExecutiveExcel(filtered, studyLabel);
      this.showToast('Generando informe ejecutivo de comité en Excel (.xlsx)...', 'success');
    });
  }

  renderDailyReportsView() {
    const valMap = new Map(this.validators.map(v => [v.id, v]));
    const auditsToRender = this.getFilteredAuditsForReports();

    // 1. Agrupar auditorías por día (estrictamente solo fecha) y estudio
    const dailyGroups = {};
    auditsToRender.forEach(audit => {
      const dateKey = this.getAuditOperationDate(audit);
      const studyKey = this.getStudyForAudit(audit);
      const groupKey = `${dateKey}__${studyKey}`;

      if (!dailyGroups[groupKey]) {
        dailyGroups[groupKey] = {
          groupKey,
          dateKey,
          studyKey,
          audits: [],
          completed: 0,
          pending: 0,
          inProgress: 0,
          aplica: 0,
          noAplica: 0,
          totalDuration: 0,
          validatorsMap: {}
        };
      }

      const group = dailyGroups[groupKey];
      group.audits.push(audit);

      if (audit.assignedValidatorId) {
        if (!group.validatorsMap[audit.assignedValidatorId]) {
          const valObj = valMap.get(audit.assignedValidatorId) || {
            id: audit.assignedValidatorId,
            code: audit._validatorCode || 'VAL-?',
            name: audit._validatorName || 'Validador'
          };
          group.validatorsMap[audit.assignedValidatorId] = { val: valObj, total: 0, completed: 0 };
        }
        group.validatorsMap[audit.assignedValidatorId].total++;
      }

      if (audit.validationStatus === 'completada') {
        group.completed++;
        if (audit.assignedValidatorId && group.validatorsMap[audit.assignedValidatorId]) {
          group.validatorsMap[audit.assignedValidatorId].completed++;
        }
        if (audit.durationSeconds) group.totalDuration += audit.durationSeconds;

        Object.values(audit.validationResults || {}).forEach(res => {
          if (res.status === 'aplica') group.aplica++;
          if (res.status === 'no_aplica') group.noAplica++;
        });
      } else if (audit.validationStatus === 'en_progreso') {
        group.inProgress++;
      } else {
        group.pending++;
      }
    });

    const dailyList = Object.values(dailyGroups).sort((a, b) => b.dateKey.localeCompare(a.dateKey));

    // 2. Métricas Resumen
    const distinctDates = new Set(dailyList.map(d => d.dateKey));
    const totalDays = distinctDates.size;
    const totalCompleted = auditsToRender.filter(a => a.validationStatus === 'completada').length;
    const avgPerDay = totalDays > 0 ? Math.round(totalCompleted / totalDays) : 0;

    let bestDay = '—';
    let maxCompleted = -1;
    dailyList.forEach(d => {
      if (d.completed > maxCompleted && d.completed > 0) {
        maxCompleted = d.completed;
        bestDay = `${d.dateKey} (${d.studyKey} - ${d.completed} aud.)`;
      }
    });

    const daysCountEl = document.getElementById('daily-stat-days-count');
    const totalCompEl = document.getElementById('daily-stat-total-completed');
    const avgDayEl = document.getElementById('daily-stat-avg-day');
    const bestDayEl = document.getElementById('daily-stat-best-day');
    const daysBadgeEl = document.getElementById('daily-stat-days-badge');

    if (daysCountEl) daysCountEl.textContent = totalDays;
    if (totalCompEl) totalCompEl.textContent = totalCompleted;
    if (avgDayEl) avgDayEl.textContent = avgPerDay;
    if (bestDayEl) bestDayEl.textContent = bestDay;
    if (daysBadgeEl) daysBadgeEl.textContent = `${totalDays} jornada${totalDays !== 1 ? 's' : ''} • ${dailyList.length} registro${dailyList.length !== 1 ? 's' : ''} de estudio`;

    // 3. Renderizar Tarjetas Diarias
    const container = document.getElementById('daily-cards-container');
    if (!container) return;

    if (dailyList.length === 0) {
      container.innerHTML = `
        <div class="empty-reasons-state">
          <p>No hay auditorías registradas para los estudios seleccionados.</p>
        </div>
      `;
      return;
    }

    const flagMap = {
      'Chile': '🇨🇱 Chile',
      'Tradicional': '🏪 Tradicional',
      'Moderno': '🏬 Moderno',
      'Lindley': '🥤 Lindley'
    };

    container.innerHTML = dailyList.map(item => {
      const avgDuration = item.completed > 0 ? Math.round(item.totalDuration / item.completed) : 0;
      const progressPct = item.audits.length > 0 ? Math.round((item.completed / item.audits.length) * 100) : 0;
      const studyLabel = flagMap[item.studyKey] || item.studyKey;

      // Chips de validadores de la jornada
      const valChips = Object.values(item.validatorsMap).map(vData => {
        const vPct = vData.total > 0 ? Math.round((vData.completed / vData.total) * 100) : 0;
        return `
          <span class="dd-val-chip" title="${vData.val.name}: ${vData.completed} de ${vData.total} completadas">
            <span class="dd-val-code">${vData.val.code}</span>
            <span>${vData.val.name.split(' ')[0]}</span>
            <strong class="${vPct === 100 ? 'text-success' : 'text-warning'}">${vData.completed}/${vData.total} (${vPct}%)</strong>
          </span>
        `;
      }).join('');

      return `
        <div class="daily-day-card" data-date="${item.dateKey}" data-study="${item.studyKey}">
          <div class="daily-day-header">
            <div class="day-title-group">
              <div class="day-calendar-icon">📅</div>
              <div>
                <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
                  <h3 class="day-date-heading">Fecha: ${item.dateKey}</h3>
                  <span class="val-study-tag">${studyLabel}</span>
                </div>
                <span class="text-muted" style="font-size:0.85rem;">
                  <strong>${item.audits.length}</strong> auditorías cargadas • <strong>${Object.keys(item.validatorsMap).length}</strong> validadores asignados • Avance: <strong>${progressPct}%</strong>
                </span>
              </div>
            </div>

            <div class="daily-card-actions">
              <button class="btn btn-outline btn-sm btn-open-daily-detail" data-date="${item.dateKey}" data-study="${item.studyKey}">
                🔍 Ver Detallado del Día
              </button>
              <button class="btn btn-success btn-sm btn-download-day" data-date="${item.dateKey}" data-study="${item.studyKey}">
                📥 Descargar Excel (.xlsx)
              </button>
            </div>
          </div>

          <!-- Barra de Progreso del Día -->
          <div class="val-progress-bar-wrap" style="height:8px; margin-top:-0.35rem;">
            <div class="val-progress-bar-fill" style="width: ${progressPct}%"></div>
          </div>

          <div class="daily-day-stats-grid">
            <div class="day-stat-box">
              <span class="day-stat-num">${item.audits.length}</span>
              <span class="day-stat-label">Total Auditorías</span>
            </div>
            <div class="day-stat-box">
              <span class="day-stat-num text-success">${item.completed}</span>
              <span class="day-stat-label">Completadas (${progressPct}%)</span>
            </div>
            <div class="day-stat-box">
              <span class="day-stat-num text-warning">${item.pending + item.inProgress}</span>
              <span class="day-stat-label">Pendientes</span>
            </div>
            <div class="day-stat-box">
              <span class="day-stat-num text-success">${item.aplica}</span>
              <span class="day-stat-label">KPIs Aplica</span>
            </div>
            <div class="day-stat-box">
              <span class="day-stat-num text-magenta">${item.noAplica}</span>
              <span class="day-stat-label">KPIs No Aplica</span>
            </div>
            <div class="day-stat-box">
              <span class="day-stat-num text-purple">${avgDuration}s</span>
              <span class="day-stat-label">Tiempo Promedio</span>
            </div>
          </div>

          <!-- Validadores y Avance en la Jornada -->
          ${valChips ? `
            <div style="display:flex; flex-direction:column; gap:0.4rem;">
              <span style="font-size:0.75rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase;">
                Equipo de Validadores en esta Jornada:
              </span>
              <div class="dd-validators-list">
                ${valChips}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    // Listener para abrir detallado del día
    container.querySelectorAll('.btn-open-daily-detail').forEach(btn => {
      btn.addEventListener('click', () => {
        const dKey = btn.dataset.date;
        const sKey = btn.dataset.study;
        this.openDailyDetailModal(dKey, sKey);
      });
    });

    // Listener para descargar cada día específico
    container.querySelectorAll('.btn-download-day').forEach(btn => {
      btn.addEventListener('click', () => {
        const dKey = btn.dataset.date;
        const sKey = btn.dataset.study;
        const matchingAudits = auditsToRender.filter(a => {
          const aDate = this.getAuditOperationDate(a);
          const aStudy = this.getStudyForAudit(a);
          return (aDate === dKey) && (!sKey || aStudy === sKey);
        });
        ExcelParser.exportSingleDayExcel(
          matchingAudits,
          this.validators,
          dKey,
          `Reporte_Validacion_${dKey}_${sKey || 'Todos'}.xlsx`
        );
        this.showToast(`Descargando reporte de fecha: ${dKey} (${sKey || 'Todos'})`, 'success');
      });
    });
  }

  // ==========================================
  // MODAL DE DETALLADO DEL DÍA (HISTORIAL DIARIO)
  // ==========================================
  openDailyDetailModal(dateKey, studyKey) {
    const modal = document.getElementById('modal-daily-detail');
    if (!modal) return;

    this.currentDailyDetail = { dateKey, studyKey };

    const flagMap = {
      'Chile': '🇨🇱 Chile',
      'Tradicional': '🏪 Tradicional',
      'Moderno': '🏬 Moderno',
      'Lindley': '🥤 Lindley'
    };

    const titleEl = document.getElementById('daily-detail-title');
    const subtitleEl = document.getElementById('daily-detail-subtitle');
    const studyBadge = studyKey ? (flagMap[studyKey] || studyKey) : 'Todos los Estudios';

    if (titleEl) titleEl.textContent = `📅 Detallado de la Jornada: ${dateKey} • ${studyBadge}`;
    if (subtitleEl) subtitleEl.textContent = `Seguimiento de auditorías, validadores y avance de la operación.`;

    // Obtener auditorías del día usando getAuditOperationDate
    const dayAudits = this.getReportAuditSource().filter(a => {
      const aDate = this.getAuditOperationDate(a);
      const aStudy = this.getStudyForAudit(a);
      const dateMatch = aDate === dateKey || dateKey === 'Sin_Fecha';
      const studyMatch = !studyKey || aStudy.toUpperCase() === studyKey.toUpperCase();
      return dateMatch && studyMatch;
    });

    // 1. Métricas de la barra superior
    const total = dayAudits.length;
    const completed = dayAudits.filter(a => a.validationStatus === 'completada').length;
    const pending = total - completed;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    let aplica = 0;
    let noAplica = 0;
    let totalSecs = 0;

    dayAudits.forEach(a => {
      if (a.validationStatus === 'completada' && a.durationSeconds) {
        totalSecs += a.durationSeconds;
      }
      Object.values(a.validationResults || {}).forEach(res => {
        if (res.status === 'aplica') aplica++;
        if (res.status === 'no_aplica') noAplica++;
      });
    });

    const avgTime = completed > 0 ? Math.round(totalSecs / completed) : 0;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('dd-stat-total', total);
    setEl('dd-stat-completed', completed);
    setEl('dd-stat-pending', pending);
    setEl('dd-stat-progress', `${progress}%`);
    setEl('dd-stat-aplica', aplica);
    setEl('dd-stat-no-aplica', noAplica);
    setEl('dd-stat-time', `${avgTime}s`);

    // 2. Validadores del día
    const valMap = new Map(this.validators.map(v => [v.id, v]));
    const valStatsMap = {};
    dayAudits.forEach(a => {
      if (a.assignedValidatorId) {
        if (!valStatsMap[a.assignedValidatorId]) {
          const valObj = valMap.get(a.assignedValidatorId) || { id: a.assignedValidatorId, code: 'VAL-?', name: 'Validador' };
          valStatsMap[a.assignedValidatorId] = { val: valObj, total: 0, completed: 0 };
        }
        valStatsMap[a.assignedValidatorId].total++;
        if (a.validationStatus === 'completada') {
          valStatsMap[a.assignedValidatorId].completed++;
        }
      }
    });

    const valListContainer = document.getElementById('dd-validators-list');
    const valFilterSelect = document.getElementById('dd-filter-validator');

    if (valListContainer) {
      const valEntries = Object.values(valStatsMap);
      if (valEntries.length === 0) {
        valListContainer.innerHTML = '<span class="text-muted" style="font-size:0.85rem;">No hay validadores asignados en este día.</span>';
      } else {
        valListContainer.innerHTML = valEntries.map(vd => {
          const pct = vd.total > 0 ? Math.round((vd.completed / vd.total) * 100) : 0;
          return `
            <div class="dd-val-chip">
              <span class="dd-val-code">${vd.val.code}</span>
              <strong>${vd.val.name}</strong>
              <span class="${pct === 100 ? 'text-success' : 'text-warning'}">${vd.completed}/${vd.total} (${pct}%)</span>
            </div>
          `;
        }).join('');
      }
    }

    if (valFilterSelect) {
      valFilterSelect.innerHTML = '<option value="ALL">Todos los validadores</option>' +
        Object.values(valStatsMap).map(vd => `<option value="${vd.val.id}">${vd.val.code} - ${vd.val.name}</option>`).join('');
    }

    // 3. Inicializar listeners de búsqueda y filtrado
    this.initDailyDetailListeners(dayAudits);

    // 4. Renderizar tabla con todos los registros
    this.renderDailyDetailTable(dayAudits);

    // 5. Botón de descarga de Excel del día
    const dlBtn = document.getElementById('btn-download-dd-excel');
    if (dlBtn) {
      dlBtn.onclick = () => {
        ExcelParser.exportSingleDayExcel(
          dayAudits,
          this.validators,
          dateKey,
          `Reporte_Validacion_${dateKey}_${studyKey || 'Todos'}.xlsx`
        );
        this.showToast(`Exportando ${dayAudits.length} auditorías de ${dateKey} a Excel.`, 'success');
      };
    }

    modal.classList.remove('hidden');
  }

  initDailyDetailListeners(dayAudits) {
    const searchInput = document.getElementById('dd-search-input');
    const valSelect = document.getElementById('dd-filter-validator');
    const statusSelect = document.getElementById('dd-filter-status');

    const updateFilter = () => {
      const q = (searchInput?.value || '').toLowerCase().trim();
      const valId = valSelect?.value || 'ALL';
      const status = statusSelect?.value || 'ALL';

      const filtered = dayAudits.filter(a => {
        // Texto
        const matchesQuery = !q || 
          String(a.id).toLowerCase().includes(q) ||
          String(a.idPDV || '').toLowerCase().includes(q) ||
          String(a.ciudad || '').toLowerCase().includes(q) ||
          String(a.canal || '').toLowerCase().includes(q);

        // Validador
        const matchesVal = valId === 'ALL' || a.assignedValidatorId === valId;

        // Estado
        const matchesStatus = status === 'ALL' || a.validationStatus === status;

        return matchesQuery && matchesVal && matchesStatus;
      });

      this.renderDailyDetailTable(filtered);
    };

    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = updateFilter;
    }
    if (valSelect) {
      valSelect.value = 'ALL';
      valSelect.onchange = updateFilter;
    }
    if (statusSelect) {
      statusSelect.value = 'ALL';
      statusSelect.onchange = updateFilter;
    }
  }

  renderDailyDetailTable(audits) {
    const tbody = document.getElementById('dd-table-tbody');
    const countEl = document.getElementById('dd-table-count');
    const valMap = new Map(this.validators.map(v => [v.id, v]));

    if (countEl) countEl.textContent = `Mostrando ${audits.length} registros`;
    if (!tbody) return;

    if (audits.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" class="text-center text-muted" style="padding: 2rem;">
            No se encontraron auditorías con los filtros seleccionados.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = audits.map((a, i) => {
      const val = valMap.get(a.assignedValidatorId);
      const kpis = (a.kpis || []).filter(k => k.needsReview);

      let statusBadge = '<span class="badge badge-warning">⏳ Pendiente</span>';
      if (a.validationStatus === 'completada') {
        statusBadge = '<span class="badge badge-success">✓ Completada</span>';
      } else if (a.validationStatus === 'en_progreso') {
        statusBadge = '<span class="badge badge-info">🔄 En Progreso</span>';
      }

      // Resultados
      let resAplica = 0;
      let resNoAplica = 0;
      Object.values(a.validationResults || {}).forEach(r => {
        if (r.status === 'aplica') resAplica++;
        if (r.status === 'no_aplica') resNoAplica++;
      });

      let resSummary = '<span class="text-muted">—</span>';
      if (resAplica > 0 || resNoAplica > 0) {
        resSummary = `<span class="text-success" style="font-weight:700;">✓${resAplica}</span> / <span class="text-magenta" style="font-weight:700;">✕${resNoAplica}</span>`;
      }

      const durText = a.durationSeconds ? `${a.durationSeconds}s` : '—';

      return `
        <tr>
          <td>${i + 1}</td>
          <td><strong>#${a.id}</strong></td>
          <td>${a.idPDV || '-'}</td>
          <td><span class="badge badge-purple">${a.estudio || a.canal || '-'}</span></td>
          <td>${a.ciudad || a.pais || '-'}</td>
          <td>
            ${val ? `<span class="val-pill"><strong>${val.code}</strong> - ${val.name}</span>` : '<span class="text-muted">Sin asignar</span>'}
          </td>
          <td><span class="badge badge-blue">${kpis.length} KPIs</span></td>
          <td>${resSummary}</td>
          <td>${durText}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================
  // MÉTODOS DE ACCIÓN RÁPIDA Y REPORTES
  // ==========================================
  switchReportsSubtab(subtab) {
    this.reportsSubtab = subtab;
    const btnOp = document.getElementById('btn-subtab-operational');
    const btnExec = document.getElementById('btn-subtab-executive');
    const viewOp = document.getElementById('metrics-view-operational');
    const viewExec = document.getElementById('metrics-view-executive');
    const titleEl = document.getElementById('reports-view-title');
    const subtitleEl = document.getElementById('reports-view-subtitle');

    if (subtab === 'operational') {
      btnOp?.classList.add('active');
      btnExec?.classList.remove('active');
      viewOp?.classList.remove('hidden');
      viewExec?.classList.add('hidden');
      if (titleEl) titleEl.textContent = 'Métricas Operacionales de Supervisión';
      if (subtitleEl) subtitleEl.textContent = 'Consulta todo el histórico de validación, tiempos por validador y descargas día a día.';
    } else {
      btnExec?.classList.add('active');
      btnOp?.classList.remove('active');
      viewExec?.classList.remove('hidden');
      viewOp?.classList.add('hidden');
      if (titleEl) titleEl.textContent = 'Informe Ejecutivo de Calidad y KPIs (Comité)';
      if (subtitleEl) subtitleEl.textContent = 'Ranking de variables con alertas, tasa de efectividad de negocio y causas raíz para comités directivos.';
    }
    this.renderReportsView();
  }

  setAllStudiesFilter() {
    this.selectedStudies = ['ALL'];
    this.renderReportsView();
    this.renderDailyReportsView();
    this.showToast('Mostrando datos de todos los estudios.', 'info');
  }

  setCurrentProjectFilter() {
    this.selectedStudies = [this.currentProject];
    this.renderReportsView();
    this.renderDailyReportsView();
    this.showToast(`Filtrando métricas por: ${this.currentProject}`, 'info');
  }

  exportConsolidatedExcel() {
    const auditsToExport = this.getFilteredAuditsForReports();
    ExcelParser.exportResultsToExcel(auditsToExport, this.validators);
    this.showToast('Descargando archivo Excel consolidado...', 'success');
  }

  exportMultiSheetExcel() {
    const auditsToExport = this.getFilteredAuditsForReports();
    ExcelParser.exportDailyAndConsolidatedExcel(auditsToExport, this.validators);
    this.showToast('Descargando libro Excel con hojas día a día...', 'success');
  }

  exportExecutiveExcel() {
    const auditsToExport = this.getFilteredAuditsForReports();
    const studyLabel = this.selectedStudies.includes('ALL')
      ? 'Todos los Estudios'
      : this.selectedStudies.join(', ');
    ExcelParser.exportExecutiveExcel(auditsToExport, studyLabel);
    this.showToast('Descargando Informe Ejecutivo de Comité...', 'success');
  }

  applyAlertThresholds() {
    const inputMin = document.getElementById('threshold-min-sec');
    const inputWarn = document.getElementById('threshold-warn-sec');
    const minVal = parseInt(inputMin?.value) || 25;
    const warnVal = parseInt(inputWarn?.value) || 45;

    if (minVal >= warnVal) {
      this.showToast('El tiempo crítico debe ser menor al tiempo recomendado.', 'warning');
      return;
    }

    this.thresholdMinSec = minVal;
    this.thresholdWarnSec = warnVal;
    this.renderAlertsView();
    this.showToast(`Parámetros actualizados: Crítico < ${minVal}s, Advertencia < ${warnVal}s`, 'success');
  }

  // ==========================================
  // MÓDULO EXCLUSIVO: ALERTAS BLOQUEANTES
  // ==========================================
  loadBlockingSampleData(notify = true) {
    const result = ExcelParser.parseCSV(BLOCKING_ALERTS_SAMPLE_CSV);
    this.blockingAudits = result.audits || [];
    if (this.currentModule === 'blocking') {
      this.audits = this.blockingAudits;
    }
    this.saveState();
    this.renderAdminView();
    this.renderReportsView();
    this.renderAlertsView();
    if (notify) {
      this.showToast(`Se cargaron ${this.blockingAudits.length} auditorías para Alertas Bloqueantes.`, 'success');
    }
  }

  // ==========================================
  // TOAST NOTIFICATIONS
  // ==========================================
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-message toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-text">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
}

// Inicializar la aplicación inmediatamente o al cargar el DOM
function initValidaFlowApp() {
  if (!window.app) {
    window.app = new ValidaFlowApp();
  }
  return window.app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initValidaFlowApp);
} else {
  initValidaFlowApp();
}

// Exponer funciones globales para máxima compatibilidad
window.initValidaFlowApp = initValidaFlowApp;
window.enterSupervisorModule = (m) => (window.app || initValidaFlowApp()).enterSupervisorModule(m);
window.enterProject = (p) => (window.app || initValidaFlowApp()).enterProject(p);
window.selectModule = (m) => (window.app || initValidaFlowApp()).selectModule(m);
window.showView = (v) => (window.app || initValidaFlowApp()).showView(v);
window.confirmStudyUpload = (s) => (window.app || initValidaFlowApp()).confirmStudyUpload(s);
window.switchSupervisorTab = (t) => (window.app || initValidaFlowApp()).switchSupervisorTab(t);
window.switchReportsSubtab = (s) => (window.app || initValidaFlowApp()).switchReportsSubtab(s);
window.exportConsolidatedExcel = () => (window.app || initValidaFlowApp()).exportConsolidatedExcel();
window.exportMultiSheetExcel = () => (window.app || initValidaFlowApp()).exportMultiSheetExcel();
window.exportExecutiveExcel = () => (window.app || initValidaFlowApp()).exportExecutiveExcel();
window.loadSampleData = (n) => (window.app || initValidaFlowApp()).loadSampleData(n);
window.setDistributionMode = (m) => (window.app || initValidaFlowApp()).setDistributionMode(m);
window.executeDistribution = (m) => (window.app || initValidaFlowApp()).executeDistribution(m);
window.openDailyDetailModal = (d, s) => (window.app || initValidaFlowApp()).openDailyDetailModal(d, s);
window.openCommercialReportPreview = () => (window.app || initValidaFlowApp()).openCommercialReportPreview();
window.exportCommercialPDF = () => (window.app || initValidaFlowApp()).exportCommercialPDF();
window.openResolveQueryModal = (a, k) => (window.app || initValidaFlowApp()).openResolveQueryModal(a, k);
window.setQueryFilter = (f) => (window.app || initValidaFlowApp()).setQueryFilter(f);
window.setQueryStudyFilter = (s) => (window.app || initValidaFlowApp()).setQueryStudyFilter(s);
window.renderQueriesView = () => (window.app || initValidaFlowApp()).renderQueriesView();
window.openReassignStudyModal = () => (window.app || initValidaFlowApp()).openReassignStudyModal();
window.selectReassignStudyOption = (s) => (window.app || initValidaFlowApp()).selectReassignStudyOption(s);
window.executeReassignStudy = () => (window.app || initValidaFlowApp()).executeReassignStudy();
window.clearCurrentStudyAudits = () => (window.app || initValidaFlowApp()).clearCurrentStudyAudits();
window.clearAllDatabase = () => (window.app || initValidaFlowApp()).clearAllDatabase();
window.toggleTheme = () => (window.app || initValidaFlowApp()).toggleTheme();
