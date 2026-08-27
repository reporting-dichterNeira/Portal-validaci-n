/**
 * Módulo de la interfaz y flujo del Validador
 */

import { formatNicaraguaDateTime, getNicaraguaDateKey } from './time-utils.js?v=1.0';

export class ValidatorUI {
  constructor(app) {
    this.app = app;
    this.currentValidator = null;
    this.currentAuditId = null;
    this.currentModule = 'smart'; // 'smart' | 'blocking'
    this.filterStatus = 'all'; // 'all' | 'pending' | 'completed'
    this.searchQuery = '';
    this.productivityRows = [];
    this.currentAuditNeedsSave = false;

    this.initElements();
    this.bindEvents();
  }

  initElements() {
    // Pantalla de login de validador
    this.loginSection = document.getElementById('validator-login-section');
    this.portalSection = document.getElementById('validator-portal-section');
    this.validatorCodeInput = document.getElementById('validator-code-input');
    this.btnValidatorLogin = document.getElementById('btn-validator-login');
    this.validatorQuickSelect = document.getElementById('validator-quick-select');

    // Header del portal
    this.valPortalName = document.getElementById('val-portal-name');
    this.valPortalCode = document.getElementById('val-portal-code');
    this.valPortalProgress = document.getElementById('val-portal-progress');
    this.valProgressBar = document.getElementById('val-progress-bar');
    this.btnValLogout = document.getElementById('btn-val-logout');
    this.btnProductivityExcel = document.getElementById('btn-val-productivity-excel');

    // Lista de auditorías (Master)
    this.auditListContainer = document.getElementById('val-audit-list');
    this.valAuditSearch = document.getElementById('val-audit-search');
    this.filterButtons = document.querySelectorAll('.val-filter-btn');

    // Detalle de auditoría (Detail)
    this.auditDetailContainer = document.getElementById('val-audit-detail');
    this.noAuditSelectedView = document.getElementById('val-no-audit-selected');
  }

  bindEvents() {
    // Login con código
    this.btnValidatorLogin?.addEventListener('click', () => {
      const code = this.validatorCodeInput?.value.trim().toUpperCase();
      this.loginWithCode(code);
    });

    this.validatorCodeInput?.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        const code = this.validatorCodeInput?.value.trim().toUpperCase();
        this.loginWithCode(code);
      }
    });

    // Selector rápido de código para pruebas ágiles
    this.validatorQuickSelect?.addEventListener('change', (e) => {
      if (e.target.value) {
        this.validatorCodeInput.value = e.target.value;
        this.loginWithCode(e.target.value);
      }
    });

    // Cerrar sesión del validador
    this.btnValLogout?.addEventListener('click', () => {
      this.logout();
    });

    this.btnProductivityExcel?.addEventListener('click', () => {
      this.exportProductivityExcel();
    });

    // Filtros de estado (Todas / Pendientes / Completadas)
    this.filterButtons?.forEach(btn => {
      btn.addEventListener('click', () => {
        this.filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filterStatus = btn.dataset.filter || 'all';
        this.renderAuditList();
      });
    });

    // Búsqueda en auditorías
    this.valAuditSearch?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase().trim();
      this.renderAuditList();
    });
  }

  async loginWithCode(code) {
    if (!code) {
      this.app.showToast('Por favor ingresa un código de validador.', 'warning');
      return;
    }

    let validator;
    try {
      if (this.btnValidatorLogin) this.btnValidatorLogin.disabled = true;
      validator = this.app.backend.configured
        ? await this.app.backend.signInValidator(code)
        : this.app.validators.find(v => v.code.toUpperCase() === code.toUpperCase());

      if (!validator) {
        throw new Error(`Código "${code}" no encontrado.`);
      }

      this.currentValidator = validator;
      if (this.app.backend.configured) {
        await this.app.refreshFromBackend();
        this.app.startRealtimeSync();
        validator = this.app.validators.find(v => v.id === validator.id) || validator;
      }
    } catch (error) {
      this.currentValidator = null;
      this.app.showToast(error.message || 'No fue posible iniciar sesión.', 'error');
      return;
    } finally {
      if (this.btnValidatorLogin) this.btnValidatorLogin.disabled = false;
    }

    this.currentValidator = validator;
    this.loginSection.classList.add('hidden');
    this.portalSection.classList.remove('hidden');

    this.valPortalName.textContent = validator.name;
    this.valPortalCode.textContent = validator.code;

    // Reset selección
    this.currentAuditId = null;
    this.currentAuditNeedsSave = false;
    this.updateProgressHeader();
    this.renderAuditList();
    await this.loadProductivity();

    // Seleccionar automáticamente la primera auditoría pendiente
    const myAudits = this.getMyAudits();
    const firstPending = myAudits.find(a => a.validationStatus !== 'completada') || myAudits[0];
    if (firstPending) {
      this.selectAudit(firstPending.id);
    } else {
      this.renderAuditDetail(null);
    }

    this.app.showToast(`Bienvenido(a), ${validator.name}`, 'success');
  }

  async logout() {
    if (this.app.backend.configured) {
      try {
        await this.app.backend.signOut();
      } catch (error) {
        console.error('Error al cerrar la sesión del validador:', error);
      }
    }
    this.currentValidator = null;
    this.currentAuditId = null;
    this.currentAuditNeedsSave = false;
    this.validatorCodeInput.value = '';
    this.loginSection.classList.remove('hidden');
    this.portalSection.classList.add('hidden');
  }

  getMyAudits(moduleKey = this.currentModule) {
    if (!this.currentValidator) return [];
    const sourceAudits = moduleKey === 'blocking' ? (this.app.blockingAudits || []) : (this.app.smartAudits || []);
    return sourceAudits.filter(a => a.assignedValidatorId === this.currentValidator.id);
  }

  switchModule(moduleKey) {
    if (moduleKey === this.currentModule) return;
    if (!this.canLeaveCurrentAudit()) return;

    this.currentModule = moduleKey;

    const pillSmart = document.getElementById('val-pill-smart');
    const pillBlocking = document.getElementById('val-pill-blocking');
    if (moduleKey === 'blocking') {
      pillBlocking?.classList.add('active');
      pillSmart?.classList.remove('active');
    } else {
      pillSmart?.classList.add('active');
      pillBlocking?.classList.remove('active');
    }

    this.currentAuditId = null;
    this.currentAuditNeedsSave = false;
    this.updateProgressHeader();
    this.renderAuditList();

    const myAudits = this.getMyAudits();
    const firstPending = myAudits.find(a => a.validationStatus !== 'completada') || myAudits[0];
    if (firstPending) {
      this.selectAudit(firstPending.id);
    } else {
      this.renderAuditDetail(null);
    }
  }

  updateProgressHeader() {
    const smartAudits = this.getMyAudits('smart');
    const blockingAudits = this.getMyAudits('blocking');

    const countSmartEl = document.getElementById('val-count-smart');
    const countBlockingEl = document.getElementById('val-count-blocking');
    if (countSmartEl) countSmartEl.textContent = smartAudits.length;
    if (countBlockingEl) countBlockingEl.textContent = blockingAudits.length;

    const currentAudits = this.getMyAudits(this.currentModule);
    const completed = currentAudits.filter(a => a.validationStatus === 'completada').length;
    const total = currentAudits.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    if (this.valPortalProgress) {
      const modTag = this.currentModule === 'smart' ? 'Smart' : 'Bloqueantes';
      this.valPortalProgress.textContent = `${completed} de ${total} (${percent}%) - ${modTag}`;
    }
    if (this.valProgressBar) {
      this.valProgressBar.style.width = `${percent}%`;
    }
  }

  async loadProductivity() {
    const today = new Date(`${getNicaraguaDateKey(new Date())}T12:00:00Z`);
    const from = new Date(today);
    from.setUTCFullYear(today.getUTCFullYear() - 5);
    const toDate = date => getNicaraguaDateKey(date);

    try {
      const rows = this.app.backend.configured
        ? await this.app.backend.loadMyValidatorProductivity({
          dateFrom: toDate(from),
          dateTo: toDate(today)
        })
        : [];
      this.productivityRows = rows;
    } catch (error) {
      console.error('No fue posible cargar la productividad del validador:', error);
      this.productivityRows = [];
    }
    this.renderProductivity();
  }

  renderProductivity() {
    const tbody = document.getElementById('val-productivity-tbody');
    if (!tbody) return;

    const days = new Map();
    this.productivityRows.forEach(row => {
      const date = row.operationDate;
      if (!date) return;
      if (!days.has(date)) days.set(date, { completed: 0, modules: new Set() });
      const day = days.get(date);
      day.completed += Number(row.completedAudits || 0);
      if (row.module) day.modules.add(row.module === 'blocking' ? 'Bloqueantes' : 'Smart');
    });

    const workedDays = [...days.entries()]
      .filter(([, day]) => day.completed > 0)
      .sort(([first], [second]) => second.localeCompare(first));
    const totalCompleted = workedDays.reduce((total, [, day]) => total + day.completed, 0);
    const daysEl = document.getElementById('val-productivity-days');
    const completedEl = document.getElementById('val-productivity-completed');
    const rangeEl = document.getElementById('val-productivity-range');
    if (daysEl) daysEl.textContent = workedDays.length;
    if (completedEl) completedEl.textContent = totalCompleted;
    if (rangeEl) rangeEl.textContent = 'Últimos 5 años';

    if (!workedDays.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Aún no tienes auditorías validadas.</td></tr>';
      return;
    }

    const dateFormatter = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' });
    tbody.innerHTML = workedDays.map(([date, day]) => `
      <tr>
        <td><strong>${dateFormatter.format(new Date(`${date}T12:00:00`))}</strong></td>
        <td>${[...day.modules].join(' · ') || '—'}</td>
        <td><strong>${day.completed}</strong></td>
      </tr>
    `).join('');
  }

  exportProductivityExcel() {
    if (!this.currentValidator) {
      this.app.showToast('Inicia sesión con tu código para descargar tu productividad.', 'warning');
      return;
    }
    if (typeof XLSX === 'undefined') {
      this.app.showToast('La herramienta de Excel aún no está disponible. Intenta nuevamente.', 'error');
      return;
    }

    const rows = [...this.productivityRows]
      .filter(row => row.operationDate)
      .sort((first, second) => {
        const byDate = String(second.operationDate).localeCompare(String(first.operationDate));
        return byDate || String(first.module || '').localeCompare(String(second.module || ''));
      });
    if (!rows.length) {
      this.app.showToast('Aún no hay productividad diaria disponible para descargar.', 'info');
      return;
    }

    const completed = rows.reduce((total, row) => total + Number(row.completedAudits || 0), 0);
    const daysWorked = new Set(rows.filter(row => Number(row.completedAudits || 0) > 0).map(row => row.operationDate)).size;
    const totalAssigned = rows.reduce((total, row) => total + Number(row.totalAudits || 0), 0);
    const totalSeconds = rows.reduce((total, row) => total + Number(row.totalDurationSeconds || 0), 0);
    const timedAudits = rows.reduce((total, row) => total + Number(row.timedAudits || 0), 0);
    const toDuration = seconds => {
      const value = Math.max(0, Math.round(Number(seconds || 0)));
      const hours = Math.floor(value / 3600);
      const minutes = Math.floor((value % 3600) / 60);
      const remainingSeconds = value % 60;
      return hours ? `${hours}h ${minutes}m ${remainingSeconds}s` : `${minutes}m ${remainingSeconds}s`;
    };
    const moduleLabel = module => module === 'blocking' ? 'Alertas Bloqueantes' : 'Validación Smart';
    const dateFormatter = new Intl.DateTimeFormat('es-NI', {
      timeZone: 'America/Managua', dateStyle: 'medium'
    });
    const formatOperationDate = value => value
      ? dateFormatter.format(new Date(`${value}T12:00:00`))
      : '—';

    const summaryRows = [
      ['RESUMEN DE PRODUCTIVIDAD DIARIA', ''],
      ['Validador', this.currentValidator.name || '—'],
      ['Código único', this.currentValidator.code || '—'],
      ['Fecha de descarga', formatNicaraguaDateTime(new Date())],
      ['Días trabajados', daysWorked],
      ['Auditorías validadas', completed],
      ['Auditorías asignadas', totalAssigned],
      ['Avance histórico', totalAssigned ? completed / totalAssigned : 0],
      ['Tiempo total registrado', toDuration(totalSeconds)],
      ['Tiempo promedio por auditoría', timedAudits ? toDuration(totalSeconds / timedAudits) : '—']
    ];
    const detailRows = rows.map(row => ({
      'Jornada': formatOperationDate(row.operationDate),
      'Fecha (YYYY-MM-DD)': row.operationDate,
      'Módulo': moduleLabel(row.module),
      'Auditorías asignadas': Number(row.totalAudits || 0),
      'Validadas': Number(row.completedAudits || 0),
      'En progreso': Number(row.inProgressAudits || 0),
      'Pendientes': Number(row.pendingAudits || 0),
      '% avance': Number(row.totalAudits || 0) ? Number(row.completedAudits || 0) / Number(row.totalAudits || 0) : 0,
      'Auditorías con tiempo': Number(row.timedAudits || 0),
      'Tiempo total': toDuration(row.totalDurationSeconds),
      'Tiempo promedio': Number(row.timedAudits || 0) ? toDuration(row.averageDurationSeconds) : '—',
      'Primera actividad (Nicaragua)': formatNicaraguaDateTime(row.firstActivityAt),
      'Última actividad (Nicaragua)': formatNicaraguaDateTime(row.lastActivityAt)
    }));

    const workbook = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet['!cols'] = [{ wch: 33 }, { wch: 34 }];
    summarySheet.B8.z = '0%';
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen');

    const detailSheet = XLSX.utils.json_to_sheet(detailRows);
    detailSheet['!cols'] = [
      { wch: 22 }, { wch: 18 }, { wch: 24 }, { wch: 20 }, { wch: 12 },
      { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 18 },
      { wch: 18 }, { wch: 31 }, { wch: 31 }
    ];
    for (let rowIndex = 2; rowIndex <= detailRows.length + 1; rowIndex++) {
      const cell = detailSheet[`H${rowIndex}`];
      if (cell) cell.z = '0%';
    }
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'Detalle diario');

    const safeCode = String(this.currentValidator.code || 'validador').replace(/[^a-z0-9_-]/gi, '_');
    XLSX.writeFile(workbook, `Mi_productividad_${safeCode}.xlsx`);
    this.app.showToast('Tu resumen diario se está descargando en Excel.', 'success');
  }

  renderAuditList() {
    if (!this.auditListContainer) return;

    let audits = this.getMyAudits();

    // Aplicar filtros
    if (this.filterStatus === 'pending') {
      audits = audits.filter(a => a.validationStatus !== 'completada');
    } else if (this.filterStatus === 'completed') {
      audits = audits.filter(a => a.validationStatus === 'completada');
    }

    // Aplicar búsqueda
    if (this.searchQuery) {
      audits = audits.filter(a => {
        return (
          a.id.toLowerCase().includes(this.searchQuery) ||
          (a.idPDV && a.idPDV.toLowerCase().includes(this.searchQuery)) ||
          (a.pais && a.pais.toLowerCase().includes(this.searchQuery)) ||
          (a.ciudad && a.ciudad.toLowerCase().includes(this.searchQuery)) ||
          (a.canal && a.canal.toLowerCase().includes(this.searchQuery))
        );
      });
    }

    // Actualizar contadores en los botones de filtro
    const myAll = this.getMyAudits();
    const pendingCount = myAll.filter(a => a.validationStatus !== 'completada').length;
    const completedCount = myAll.filter(a => a.validationStatus === 'completada').length;

    const countAll = document.getElementById('count-filter-all');
    const countPending = document.getElementById('count-filter-pending');
    const countCompleted = document.getElementById('count-filter-completed');

    if (countAll) countAll.textContent = myAll.length;
    if (countPending) countPending.textContent = pendingCount;
    if (countCompleted) countCompleted.textContent = completedCount;

    if (audits.length === 0) {
      this.auditListContainer.innerHTML = `
        <div class="empty-state-card">
          <div class="empty-icon">🔍</div>
          <p>No se encontraron auditorías con los criterios actuales.</p>
        </div>
      `;
      return;
    }

    this.auditListContainer.innerHTML = audits.map(audit => {
      const isSelected = audit.id === this.currentAuditId;
      const isCompleted = audit.validationStatus === 'completada';
      const kpisToReview = (audit.kpis || []).filter(k => k.needsReview);
      
      const statusBadge = isCompleted 
        ? `<span class="badge badge-success">✓ Completada</span>`
        : `<span class="badge badge-warning">⚡ Pendiente</span>`;
      const carryoverBadge = audit._carriedOver
        ? `<span class="badge badge-info" title="Pendiente desde ${audit._carriedFromDate || 'la jornada anterior'}">↪ Día anterior</span>`
        : '';

      return `
        <div class="audit-card-item ${isSelected ? 'selected' : ''} ${isCompleted ? 'is-completed' : ''}" 
             data-id="${audit.id}">
          <div class="audit-card-top">
            <span class="audit-id-badge">#${audit.id}</span>
            <span>${carryoverBadge} ${statusBadge}</span>
          </div>
          <div class="audit-card-meta">
            <div class="meta-row"><span class="meta-label">PDV:</span> <strong>${audit.idPDV || 'N/A'}</strong></div>
            <div class="meta-row"><span class="meta-label">Ubicación:</span> ${audit.ciudad || ''}, ${audit.pais || ''}</div>
            <div class="meta-row"><span class="meta-label">Fecha:</span> ${audit.fecha || 'N/A'}</div>
          </div>
          <div class="audit-card-kpi-summary">
            <span class="kpi-count-pill">${kpisToReview.length} KPI${kpisToReview.length !== 1 ? 's' : ''} a revisar</span>
          </div>
        </div>
      `;
    }).join('');

    // Listener de clic en items
    this.auditListContainer.querySelectorAll('.audit-card-item').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        this.selectAudit(id);
      });
    });
  }

  canLeaveCurrentAudit(targetAuditId = null) {
    const isChangingAudit = !targetAuditId || String(targetAuditId) !== String(this.currentAuditId);
    if (!this.currentAuditId || !this.currentAuditNeedsSave || !isChangingAudit) return true;

    this.app.showToast(
      `Guarda la Auditoría #${this.currentAuditId} como borrador o termínala antes de abrir otra.`,
      'warning'
    );
    return false;
  }

  markCurrentAuditUnsaved(audit) {
    if (String(audit?.id) === String(this.currentAuditId)) {
      this.currentAuditNeedsSave = true;
    }
  }

  selectAudit(id) {
    if (!this.canLeaveCurrentAudit(id)) return false;

    this.currentAuditId = id;
    const source = this.currentModule === 'blocking'
      ? (this.app.blockingAudits || [])
      : (this.app.smartAudits || []);
    const audit = source.find(a => String(a.id) === String(id));

    if (audit && !audit.startedAt && audit.validationStatus !== 'completada') {
      audit.startedAt = new Date().toISOString();
      audit.validationStatus = 'en_progreso';
      this.app.syncStateAcrossTabs({ audit, module: this.currentModule });
    }
    this.currentAuditNeedsSave = Boolean(audit && audit.validationStatus !== 'completada');

    // Actualizar clase seleccionada en la lista
    this.auditListContainer?.querySelectorAll('.audit-card-item').forEach(card => {
      if (card.dataset.id === id) {
        card.classList.add('selected');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        card.classList.remove('selected');
      }
    });

    this.renderAuditDetail(audit);
    return true;
  }

  renderAuditDetail(audit) {
    if (!audit) {
      if (this.noAuditSelectedView) this.noAuditSelectedView.classList.remove('hidden');
      if (this.auditDetailContainer) this.auditDetailContainer.classList.add('hidden');
      return;
    }

    if (this.noAuditSelectedView) this.noAuditSelectedView.classList.add('hidden');
    if (this.auditDetailContainer) this.auditDetailContainer.classList.remove('hidden');

    const kpisToReview = (audit.kpis || []).filter(k => k.needsReview);
    const isCompleted = audit.validationStatus === 'completada';

    // Generar formulario de KPIs dinámicos
    const kpisHtml = kpisToReview.length > 0 ? kpisToReview.map((kpi, index) => {
      const result = audit.validationResults[kpi.name] || {};
      const status = result.status || null; // 'aplica' | 'no_aplica' | 'duda'
      const tipificacion = result.tipificacion || '';
      const dudaText = result.dudaText || '';
      const supervisorResponse = result.supervisorResponse || '';
      const observaciones = result.observaciones || '';

      const tipificacionesOptions = this.app.tipificaciones.map(t => {
        const isSel = tipificacion === t ? 'selected' : '';
        return `<option value="${t}" ${isSel}>${t}</option>`;
      }).join('');

      return `
        <div class="kpi-review-card ${status ? 'answered' : ''} ${status === 'duda' ? 'card-has-doubt' : ''}" data-kpi="${kpi.name}">
          <div class="kpi-header">
            <div class="kpi-title-box">
              <span class="kpi-badge-number">${index + 1}</span>
              <h4 class="kpi-title">${kpi.name}</h4>
              ${status === 'duda' ? `<span class="badge badge-warning" style="font-size:0.72rem;">❓ Consulta al Supervisor</span>` : ''}
            </div>
            <div class="kpi-header-right">
              <span class="kpi-original-alert">Alerta: <strong>${kpi.originalValue || 'Revisar'}</strong></span>
              ${kpi.variation ? `
                <div class="blocking-kpi-metrics-pill" style="display:flex; gap:0.5rem; align-items:center; background:var(--dn-blue-light); padding:0.25rem 0.65rem; border-radius:6px; font-size:0.78rem; font-weight:700; margin-top:0.35rem; color:var(--dn-navy);">
                  <span>Actual: <strong>${kpi.actualVal}</strong></span>
                  <span>•</span>
                  <span>Anterior: <strong>${kpi.prevVal}</strong></span>
                  <span>•</span>
                  <span class="text-danger">Variación: <strong>${kpi.variation}%</strong></span>
                  ${kpi.criterio ? `<span class="badge badge-warning" style="font-size:0.7rem;">${kpi.criterio}</span>` : ''}
                </div>
              ` : ''}
            </div>
          </div>

          <div class="kpi-action-selector">
            <label class="kpi-radio-btn ${status === 'aplica' ? 'active-aplica' : ''}">
              <input type="radio" name="kpi_status_${index}" value="aplica" ${status === 'aplica' ? 'checked' : ''} />
              <span class="radio-icon">✓</span>
              <span class="radio-text-main">Aplica</span>
            </label>

            <label class="kpi-radio-btn ${status === 'no_aplica' ? 'active-no-aplica' : ''}">
              <input type="radio" name="kpi_status_${index}" value="no_aplica" ${status === 'no_aplica' ? 'checked' : ''} />
              <span class="radio-icon">✕</span>
              <span class="radio-text-main">No Aplica</span>
            </label>

            <label class="kpi-radio-btn kpi-btn-doubt ${status === 'duda' ? 'active-duda' : ''}" title="Tengo dudas sobre este KPI y requiero orientación del supervisor">
              <input type="radio" name="kpi_status_${index}" value="duda" ${status === 'duda' ? 'checked' : ''} />
              <span class="radio-icon">❓</span>
              <span class="radio-text-main">Consultar</span>
            </label>
          </div>

          <!-- Menú condicional de tipificación cuando NO APLICA (Falso Positivo) -->
          <div class="tipificacion-container ${status === 'no_aplica' ? 'visible' : 'hidden'}" id="tipif_box_${index}">
            <div class="tipificacion-header">
              <span class="tipif-icon">🛡️</span>
              <label for="tipif_select_${index}"><strong>Tipificación del por qué NO aplicó:</strong></label>
            </div>
            <select class="form-select tipif-select" id="tipif_select_${index}" data-kpi="${kpi.name}">
              <option value="">-- Selecciona el motivo de no aplicación --</option>
              ${tipificacionesOptions}
            </select>

            <div class="observaciones-box">
              <label for="obs_${index}">Observaciones adicionales (opcional):</label>
              <textarea class="form-control obs-textarea" id="obs_${index}" data-kpi="${kpi.name}" rows="2" placeholder="Detalla el motivo si es necesario...">${observaciones}</textarea>
            </div>
          </div>

          <!-- Menú condicional cuando el validador marca DUDA / CONSULTA ❓ -->
          <div class="duda-container ${status === 'duda' ? 'visible' : 'hidden'}" id="duda_box_${index}">
            <div class="duda-header">
              <span class="duda-icon">❓</span>
              <label for="duda_input_${index}"><strong>Consulta para el Supervisor:</strong></label>
            </div>
            <p class="duda-hint">Escribe qué duda tienes con la foto, producto o criterio para que el supervisor la resuelva:</p>
            <textarea class="form-control duda-textarea" id="duda_input_${index}" data-kpi="${kpi.name}" rows="2" placeholder="Ej: No queda claro si la exhibición secundaria cumple el criterio de marca en este canal...">${dudaText}</textarea>

            ${supervisorResponse ? `
              <div class="supervisor-feedback-box">
                <div class="sup-feed-header">
                  <span>💬 <strong>Instrucción del Supervisor:</strong></span>
                  <span class="badge ${result.supervisorDecision === 'aplica' ? 'badge-success' : 'badge-danger'}">${result.supervisorDecision === 'aplica' ? 'Dictamen: Aplica' : 'Dictamen: No Aplica'}</span>
                </div>
                <p class="sup-feed-text">"${supervisorResponse}"</p>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('') : `
      <div class="no-kpis-box">
        <p>Esta auditoría no tiene KPIs pendientes de revisar marcados con "Revisar".</p>
      </div>
    `;

    this.auditDetailContainer.innerHTML = `
      <div class="audit-detail-header">
        <div class="detail-header-left">
          <div class="detail-title-row">
            <h2>Auditoría #${audit.id}</h2>
            ${isCompleted ? '<span class="badge badge-success-lg">✓ Validada y Guardada</span>' : '<span class="badge badge-warning-lg">En Proceso de Revisión</span>'}
          </div>
          <p class="detail-subtitle">Revisión caso por caso en aplicativo</p>
        </div>

        <div class="detail-header-actions">
          <button class="btn btn-outline" id="btn-save-draft" title="Guardar cambios sin marcar como terminada">
            💾 Guardar Borrador
          </button>
          <button class="btn btn-primary btn-glow" id="btn-complete-next">
            ${isCompleted ? '💾 Actualizar y Siguiente ⏭️' : '✓ Completar y Siguiente ⏭️'}
          </button>
        </div>
        ${!isCompleted ? '<p class="text-muted" style="width:100%; margin:0.6rem 0 0; font-size:0.82rem;">Para abrir otra auditoría, guarda esta como borrador o termínala.</p>' : ''}
      </div>

      <!-- Cuadrícula de Metadatos de la Auditoría -->
      <div class="audit-metadata-grid">
        <div class="meta-item">
          <span class="meta-item-label">ID PDV</span>
          <span class="meta-item-value">${audit.idPDV || 'N/A'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">País</span>
          <span class="meta-item-value">${audit.pais || 'N/A'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">Ciudad / Región</span>
          <span class="meta-item-value">${audit.ciudad || 'N/A'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">Canal</span>
          <span class="meta-item-value">${audit.canal || 'N/A'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">Fecha del Audito</span>
          <span class="meta-item-value">${audit.fecha || 'N/A'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">Auditor de Campo</span>
          <span class="meta-item-value">${audit.usuario || 'N/A'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">Inicio de validación (Nicaragua)</span>
          <span class="meta-item-value">${formatNicaraguaDateTime(audit.startedAt, 'Aún no iniciada')}</span>
        </div>
        <div class="meta-item">
          <span class="meta-item-label">Fin de validación (Nicaragua)</span>
          <span class="meta-item-value">${formatNicaraguaDateTime(audit.completedAt, 'Pendiente')}</span>
        </div>
      </div>

      <!-- Sección de Validación de KPIs -->
      <div class="kpis-section">
        <div class="kpis-section-title">
          <h3>Alertas a Evaluar (${kpisToReview.length} KPIs)</h3>
          <p>Indica si cada alerta aplicaba, no aplicaba o consulta con ❓ al supervisor en caso de dudas.</p>
        </div>

        <div class="kpi-list">
          ${kpisHtml}
        </div>
      </div>

      <div class="audit-footer-actions">
        <button class="btn btn-secondary" id="btn-prev-audit">⬅️ Anterior</button>
        <div class="footer-center-msg" id="validation-error-msg"></div>
        <button class="btn btn-primary btn-glow" id="btn-complete-next-bottom">
          ${isCompleted ? '💾 Actualizar y Siguiente ⏭️' : '✓ Completar y Siguiente ⏭️'}
        </button>
      </div>
    `;

    // Vincular interactividad de radio buttons y tipificaciones
    this.bindDetailEvents(audit, kpisToReview);
  }

  bindDetailEvents(audit, kpisToReview) {
    const kpiCards = this.auditDetailContainer.querySelectorAll('.kpi-review-card');

    kpiCards.forEach((card, index) => {
      const kpiName = card.dataset.kpi;
      const radioAplica = card.querySelector(`input[value="aplica"]`);
      const radioNoAplica = card.querySelector(`input[value="no_aplica"]`);
      const radioDuda = card.querySelector(`input[value="duda"]`);
      const tipifBox = card.querySelector(`#tipif_box_${index}`);
      const tipifSelect = card.querySelector(`#tipif_select_${index}`);
      const dudaBox = card.querySelector(`#duda_box_${index}`);
      const dudaInput = card.querySelector(`#duda_input_${index}`);
      const obsTextarea = card.querySelector(`#obs_${index}`);

      const labelAplica = radioAplica?.closest('.kpi-radio-btn');
      const labelNoAplica = radioNoAplica?.closest('.kpi-radio-btn');
      const labelDuda = radioDuda?.closest('.kpi-radio-btn');

      // 1. Cambio a Aplica
      radioAplica?.addEventListener('change', () => {
        labelAplica?.classList.add('active-aplica');
        labelNoAplica?.classList.remove('active-no-aplica');
        labelDuda?.classList.remove('active-duda');

        tipifBox?.classList.remove('visible');
        tipifBox?.classList.add('hidden');
        dudaBox?.classList.remove('visible');
        dudaBox?.classList.add('hidden');
        card.classList.add('answered');
        card.classList.remove('card-has-doubt');

        if (!audit.validationResults[kpiName]) audit.validationResults[kpiName] = {};
        audit.validationResults[kpiName].status = 'aplica';
        audit.validationResults[kpiName].tipificacion = '';
        const decisionAt = new Date().toISOString();
        // This is deliberately separate from updatedAt: observations can be
        // edited later, but the PDV history must retain when the validator
        // last clicked the final decision for this specific alert.
        audit.validationResults[kpiName].decisionAt = decisionAt;
        audit.validationResults[kpiName].updatedAt = decisionAt;
        this.markCurrentAuditUnsaved(audit);
        this.app.saveState();
      });

      // 2. Cambio a No Aplica (Desplegar tipificación)
      radioNoAplica?.addEventListener('change', () => {
        labelNoAplica?.classList.add('active-no-aplica');
        labelAplica?.classList.remove('active-aplica');
        labelDuda?.classList.remove('active-duda');

        tipifBox?.classList.remove('hidden');
        tipifBox?.classList.add('visible');
        dudaBox?.classList.remove('visible');
        dudaBox?.classList.add('hidden');
        card.classList.add('answered');
        card.classList.remove('card-has-doubt');

        setTimeout(() => tipifSelect?.focus(), 150);

        if (!audit.validationResults[kpiName]) audit.validationResults[kpiName] = {};
        audit.validationResults[kpiName].status = 'no_aplica';
        audit.validationResults[kpiName].tipificacion = tipifSelect?.value || '';
        const decisionAt = new Date().toISOString();
        audit.validationResults[kpiName].decisionAt = decisionAt;
        audit.validationResults[kpiName].updatedAt = decisionAt;
        this.markCurrentAuditUnsaved(audit);
        this.app.saveState();
      });

      // 3. Cambio a Duda ❓ (Consultar al Supervisor)
      radioDuda?.addEventListener('change', () => {
        labelDuda?.classList.add('active-duda');
        labelAplica?.classList.remove('active-aplica');
        labelNoAplica?.classList.remove('active-no-aplica');

        dudaBox?.classList.remove('hidden');
        dudaBox?.classList.add('visible');
        tipifBox?.classList.remove('visible');
        tipifBox?.classList.add('hidden');
        card.classList.add('answered');
        card.classList.add('card-has-doubt');

        setTimeout(() => dudaInput?.focus(), 150);

        if (!audit.validationResults[kpiName]) audit.validationResults[kpiName] = {};
        audit.validationResults[kpiName].status = 'duda';
        audit.validationResults[kpiName].dudaText = dudaInput?.value.trim() || '';
        audit.validationResults[kpiName].dudaCreatedAt = audit.validationResults[kpiName].dudaCreatedAt || new Date().toISOString();
        audit.validationResults[kpiName].updatedAt = new Date().toISOString();
        this.markCurrentAuditUnsaved(audit);
        this.app.saveState();
      });

      // Cambio en el desplegable de tipificación
      tipifSelect?.addEventListener('change', (e) => {
        if (!audit.validationResults[kpiName]) audit.validationResults[kpiName] = {};
        audit.validationResults[kpiName].tipificacion = e.target.value;
        audit.validationResults[kpiName].updatedAt = new Date().toISOString();
        this.markCurrentAuditUnsaved(audit);
        this.app.saveState();
      });

      // Cambio en textarea de duda al supervisor
      dudaInput?.addEventListener('input', (e) => {
        if (!audit.validationResults[kpiName]) audit.validationResults[kpiName] = {};
        audit.validationResults[kpiName].dudaText = e.target.value;
        audit.validationResults[kpiName].updatedAt = new Date().toISOString();
        this.markCurrentAuditUnsaved(audit);
        this.app.saveState();
      });

      // Cambio en observaciones
      obsTextarea?.addEventListener('input', (e) => {
        if (!audit.validationResults[kpiName]) audit.validationResults[kpiName] = {};
        audit.validationResults[kpiName].observaciones = e.target.value;
        audit.validationResults[kpiName].updatedAt = new Date().toISOString();
        this.markCurrentAuditUnsaved(audit);
        this.app.saveState();
      });
    });

    // Guardar borrador
    const btnDraft = document.getElementById('btn-save-draft');
    btnDraft?.addEventListener('click', async () => {
      this.collectFormData(audit);
      audit.validationStatus = 'en_progreso';
      const originalLabel = btnDraft.innerHTML;
      btnDraft.disabled = true;
      btnDraft.textContent = 'Guardando...';
      try {
        await this.app.syncStateAcrossTabs(
          { audit, module: this.currentModule },
          { suppressErrorToast: true }
        );
        this.mergeAuditIntoAppState(audit);
        this.currentAuditNeedsSave = false;
        this.updateProgressHeader();
        this.renderAuditList();
        this.app.showToast('Borrador guardado correctamente.', 'info');
      } catch (error) {
        console.error('No fue posible guardar el borrador:', error);
        this.app.showToast(error?.message || 'No se pudo guardar el borrador en Supabase.', 'error');
      } finally {
        if (btnDraft.isConnected) {
          btnDraft.disabled = false;
          btnDraft.innerHTML = originalLabel;
        }
      }
    });

    // Botones de completar y siguiente
    const btnNextTop = document.getElementById('btn-complete-next');
    const btnNextBottom = document.getElementById('btn-complete-next-bottom');
    const handleComplete = () => this.completeAndAdvance(audit, kpisToReview);

    btnNextTop?.addEventListener('click', handleComplete);
    btnNextBottom?.addEventListener('click', handleComplete);

    // Botón Anterior
    const btnPrev = document.getElementById('btn-prev-audit');
    btnPrev?.addEventListener('click', () => {
      this.navigateRelativeAudit(-1);
    });
  }

  collectFormData(audit) {
    const kpiCards = this.auditDetailContainer.querySelectorAll('.kpi-review-card');
    kpiCards.forEach((card, index) => {
      const kpiName = card.dataset.kpi;
      const radioAplica = card.querySelector(`input[value="aplica"]`);
      const radioNoAplica = card.querySelector(`input[value="no_aplica"]`);
      const radioDuda = card.querySelector(`input[value="duda"]`);
      const tipifSelect = card.querySelector(`#tipif_select_${index}`);
      const dudaInput = card.querySelector(`#duda_input_${index}`);
      const obsTextarea = card.querySelector(`#obs_${index}`);

      if (radioAplica?.checked) {
        const previous = audit.validationResults[kpiName] || {};
        audit.validationResults[kpiName] = {
          ...previous,
          status: 'aplica',
          tipificacion: '',
          observaciones: obsTextarea?.value.trim() || '',
          updatedAt: new Date().toISOString(),
          decisionAt: previous.decisionAt || null
        };
      } else if (radioNoAplica?.checked) {
        const previous = audit.validationResults[kpiName] || {};
        audit.validationResults[kpiName] = {
          ...previous,
          status: 'no_aplica',
          tipificacion: tipifSelect?.value || '',
          observaciones: obsTextarea?.value.trim() || '',
          updatedAt: new Date().toISOString(),
          decisionAt: previous.decisionAt || null
        };
      } else if (radioDuda?.checked) {
        const prev = audit.validationResults[kpiName] || {};
        audit.validationResults[kpiName] = {
          ...prev,
          status: 'duda',
          dudaText: dudaInput?.value.trim() || '',
          dudaCreatedAt: prev.dudaCreatedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
    });
  }

  mergeAuditIntoAppState(audit) {
    const source = this.currentModule === 'blocking'
      ? (this.app.blockingAudits || [])
      : (this.app.smartAudits || []);
    const current = source.find(item => String(item.id) === String(audit.id));
    if (current && current !== audit) Object.assign(current, audit);
    this.app.saveState();
  }

  async completeAndAdvance(audit, kpisToReview) {
    this.collectFormData(audit);

    // Validar que todos los KPIs requeridos hayan sido evaluados
    const unselectedKpis = [];
    const missingTipification = [];
    let hasDoubts = false;

    kpisToReview.forEach(kpi => {
      const res = audit.validationResults[kpi.name];
      if (!res || !res.status) {
        unselectedKpis.push(kpi.name);
      } else if (res.status === 'no_aplica' && !res.tipificacion) {
        missingTipification.push(kpi.name);
      } else if (res.status === 'duda') {
        hasDoubts = true;
      }
    });

    const errorMsgBox = document.getElementById('validation-error-msg');

    if (unselectedKpis.length > 0) {
      const msg = `Faltan ${unselectedKpis.length} KPI(s) por responder. Marca Aplica, No Aplica o ❓ Consulta.`;
      if (errorMsgBox) errorMsgBox.innerHTML = `<span class="text-danger">⚠️ ${msg}</span>`;
      this.app.showToast(msg, 'warning');
      return;
    }

    if (missingTipification.length > 0) {
      const msg = `Debes seleccionar la tipificación para los KPIs marcados como "No Aplica".`;
      if (errorMsgBox) errorMsgBox.innerHTML = `<span class="text-danger">⚠️ ${msg}</span>`;
      this.app.showToast(msg, 'warning');
      return;
    }

    const previousProgress = {
      validationStatus: audit.validationStatus,
      completedAt: audit.completedAt,
      fechaValidacion: audit.fechaValidacion,
      fecha: audit.fecha,
      durationSeconds: audit.durationSeconds
    };
    const now = new Date();
    const dateOnly = getNicaraguaDateKey(now);
    audit.fechaValidacion = dateOnly;

    if (audit.startedAt) {
      const diffMs = now.getTime() - new Date(audit.startedAt).getTime();
      audit.durationSeconds = Math.max(2, Math.round(diffMs / 1000));
    } else {
      audit.durationSeconds = 8;
    }

    if (hasDoubts) {
      // Si tiene dudas pendientes para el supervisor, queda en progreso y se notifica
      audit.validationStatus = 'en_progreso';
      audit.completedAt = null;
    } else {
      // Si todos los KPIs fueron resueltos, queda completada
      audit.validationStatus = 'completada';
      audit.completedAt = now.toISOString();
    }

    const completeButtons = [
      document.getElementById('btn-complete-next'),
      document.getElementById('btn-complete-next-bottom')
    ].filter(Boolean);
    const originalLabels = completeButtons.map(button => button.innerHTML);
    completeButtons.forEach(button => {
      button.disabled = true;
      button.textContent = 'Guardando en Supabase...';
    });

    try {
      // Do not navigate until Supabase confirms that this exact audit was saved.
      const savedAudit = await this.app.syncStateAcrossTabs(
        { audit, module: this.currentModule },
        { suppressErrorToast: true }
      );
      if (savedAudit) Object.assign(audit, savedAudit);
    } catch (error) {
      Object.assign(audit, previousProgress);
      this.app.saveState();
      this.updateProgressHeader();
      this.renderAuditList();
      const message = error?.message || 'No se pudo guardar la auditoría en Supabase.';
      if (errorMsgBox) {
        errorMsgBox.innerHTML = `<span class="text-danger">⚠️ ${message} Intenta nuevamente.</span>`;
      }
      console.error('No fue posible completar la auditoría:', error);
      this.app.showToast(`${message} La auditoría no se marcó como completada.`, 'error');
      completeButtons.forEach((button, index) => {
        if (button.isConnected) {
          button.disabled = false;
          button.innerHTML = originalLabels[index];
        }
      });
      return;
    }

    this.mergeAuditIntoAppState(audit);
    this.currentAuditNeedsSave = false;
    this.updateProgressHeader();
    this.renderAuditList();
    await this.loadProductivity();
    if (hasDoubts) {
      this.app.showToast(`❓ Consulta guardada para el supervisor en la Auditoría #${audit.id}. Pasando al siguiente caso...`, 'info');
    } else {
      this.app.showToast(`¡Auditoría #${audit.id} guardada y completada exitosamente!`, 'success');
    }

    // Avanzar a la siguiente auditoría pendiente
    const myAudits = this.getMyAudits();
    const nextPending = myAudits.find(a => a.validationStatus !== 'completada' && a.id !== audit.id);

    if (nextPending) {
      setTimeout(() => {
        this.selectAudit(nextPending.id);
      }, 250);
    } else {
      this.renderAuditDetail(audit);
      if (!hasDoubts) {
        this.showCelebrationModal();
      }
    }
  }

  navigateRelativeAudit(direction) {
    const myAudits = this.getMyAudits();
    const currentIndex = myAudits.findIndex(a => a.id === this.currentAuditId);
    if (currentIndex === -1) return;

    const targetIndex = currentIndex + direction;
    if (targetIndex >= 0 && targetIndex < myAudits.length) {
      this.selectAudit(myAudits[targetIndex].id);
    }
  }

  showCelebrationModal() {
    this.app.showToast('🎉 ¡Felicidades! Has completado todas las auditorías asignadas.', 'success');
    this.selectAudit(this.currentAuditId); // Refresca detalle
  }

  populateQuickSelect(validators) {
    if (!this.validatorQuickSelect) return;

    // Agrupar por estudio
    const studies = ['Chile', 'Tradicional', 'Moderno', 'Lindley'];
    const groups = { 'Chile': [], 'Tradicional': [], 'Moderno': [], 'Lindley': [] };
    const others = [];

    (validators || []).forEach(v => {
      const st = v.estudio || 'Tradicional';
      if (groups[st]) {
        groups[st].push(v);
      } else {
        others.push(v);
      }
    });

    let html = '<option value="">-- O selecciona un validador de prueba --</option>';

    const flagMap = {
      'Chile': '🇨🇱 Chile (Región Sur)',
      'Tradicional': '🏪 Canal Tradicional (Tiendas / Bodegas)',
      'Moderno': '🏬 Canal Moderno (Grandes Cadenas)',
      'Lindley': '🥤 Arca Continental Lindley'
    };

    studies.forEach(st => {
      const list = groups[st];
      if (list && list.length > 0) {
        html += `<optgroup label="${flagMap[st] || st}">`;
        list.forEach(v => {
          html += `<option value="${v.code}">${v.code} — ${v.name}</option>`;
        });
        html += '</optgroup>';
      }
    });

    if (others.length > 0) {
      html += '<optgroup label="Otros Estudios">';
      others.forEach(v => {
        html += `<option value="${v.code}">${v.code} — ${v.name} (${v.estudio || 'General'})</option>`;
      });
      html += '</optgroup>';
    }

    this.validatorQuickSelect.innerHTML = html;
  }
}
