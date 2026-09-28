const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadExcelParser() {
  const source = fs.readFileSync(path.join(root, 'js/excel-parser.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export class ExcelParser', 'class ExcelParser');
  const downloads = [];
  const blobs = [];
  const context = vm.createContext({
    formatNicaraguaDateTime: value => value || 'Pendiente',
    getNicaraguaDateKey: value => value || '',
    Blob: class Blob { constructor(parts, options) { this.parts = parts; this.options = options; blobs.push(this); } },
    URL: { createObjectURL: () => 'blob:consolidated', revokeObjectURL: () => {} },
    document: {
      body: { appendChild: link => downloads.push(link) },
      createElement: () => ({ style: {}, click() { this.clicked = true; }, remove() {} })
    }
  });
  vm.runInContext(`${source}\nthis.ExcelParser = ExcelParser;`, context);
  return { ExcelParser: context.ExcelParser, downloads, blobs };
}

function loadAppClass(document = { getElementById: () => null }) {
  const rawSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const source = rawSource
    .slice(0, rawSource.indexOf('// Inicializar la aplicación inmediatamente'))
    .replace(/^import .*;\r?\n/gm, '');
  const context = vm.createContext({
    window: { setTimeout }, document, console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    BroadcastChannel: class { postMessage() {} close() {} },
    SAMPLE_CSV_DATA: '', BLOCKING_ALERTS_SAMPLE_CSV: '', DEFAULT_VALIDATORS: [], DEFAULT_TIPIFICACIONES: [],
    TIPIFICACIONES_POR_DECISION: {}, seedSampleValidations: () => {},
    ExcelParser: {
      cleanDateOnly: value => String(value || '').slice(0, 10),
      normalizeHeader: value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
      normalizeCountry: value => {
        const raw = String(value || '').trim();
        if (!raw || /^\d+$/.test(raw)) return '';
        return /^(peru|perú)$/i.test(raw) ? 'Perú' : raw;
      }
    },
    getStudyDisplayName: value => value, loadPowerPointEngine: () => {}, buildExecutivePowerPoint: () => {},
    Distributor: class {}, ValidatorUI: class {}, SupabaseBackend: class {},
    formatNicaraguaDate: value => value, formatNicaraguaDateTime: value => value,
    getNicaraguaDateKey: value => typeof value === 'string'
      ? value.slice(0, 10)
      : new Date(value).toISOString().slice(0, 10)
  });
  vm.runInContext(`${source}\nthis.ValidaFlowApp = ValidaFlowApp;`, context);
  return context.ValidaFlowApp;
}

test('el consolidado grande se genera como un único CSV con las columnas de auditoría', () => {
  const { ExcelParser, downloads, blobs } = loadExcelParser();
  const result = ExcelParser.exportResultsToCsv([
    { id: '9001', idPDV: '123', pais: 'Colombia', fecha: '2026-09-12', usuario: 'Ana', validationStatus: 'completed', kpis: [{ name: 'Exhibición', needsReview: true }], validationResults: { Exhibición: { status: 'aplica', observaciones: 'Correcto; revisado' } } },
    { id: '9001', idPDV: '123', kpis: [] }
  ], [{ id: 'validator-1', name: 'Luis', code: 'VAL-1' }]);

  assert.equal(result.format, 'csv');
  assert.equal(result.rows, 1);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].download, 'Auditorias_Validadas_Consolidado.csv');
  assert.equal(blobs.length, 1);
  assert.match(blobs[0].parts.join(''), /^\uFEFF"ID Auditoría";/);
  assert.match(blobs[0].parts.join(''), /"Correcto; revisado"/);
});

test('las cargas KO toman el nombre de país y nunca el ID_PAIS numérico', () => {
  const { ExcelParser } = loadExcelParser();
  const headers = ['ID_AUDITO', 'ID_PDV', 'ID_PAIS', 'PAIS', 'MODELO_NAME', 'KPI_SUBKPI'];
  const transformed = ExcelParser.transformRowBasedAlerts([
    headers,
    ['7001', '90001', '604', 'PERU', 'MODERNO', 'Disponibilidad']
  ], headers);
  assert.equal(transformed.audits.length, 1);
  assert.equal(transformed.audits[0].pais, 'Perú');
  assert.equal(ExcelParser.normalizeCountry('GLB'), '');
  assert.equal(ExcelParser.normalizeCountry('604'), '');
  assert.equal(ExcelParser.normalizeCountry('604.0'), '');
  const blockingWithoutCountryHeader = ExcelParser.transformRowsToObjects([
    ['OlaID', 'FECHA_AUDITO', 'ID_PAIS', '', 'ID_PDV', 'ID_AUDITO', 'ESTUDIO', 'ID_SUBKPI'],
    ['2014', '2026-10-01', '1097', 'Costa Rica', '90001', '7002', 'FEMSA', 'NOTA PDV']
  ]);
  assert.equal(blockingWithoutCountryHeader.audits[0].pais, 'Costa Rica');
  const smartWithoutCountryHeader = ExcelParser.transformRowsToObjects([
    ['ID_de_audito', 'ID_de_PDV', 'Estado', 'Fecha_del_audito', 'canal', '', 'nombre_usuario', 'Alerta precio'],
    ['7003', '90002', 'Alerta', '2026-10-01', 'MODERNO', 'El Salvador', 'auditor', 'Revisar']
  ]);
  assert.equal(smartWithoutCountryHeader.audits[0].pais, 'El Salvador');
});

test('el rango de fecha filtra el histórico operativo y conserva los meses que se cruzan con el rango', () => {
  const ValidaFlowApp = loadAppClass();
  const app = Object.create(ValidaFlowApp.prototype);
  Object.assign(app, {
    currentView: 'visualizations', visualizationDateFrom: '2026-09-10', visualizationDateTo: '2026-09-12',
    selectedStudies: ['ALL'], getReportAuditSource: () => [
      { id: 'before', fecha: '2026-09-09' }, { id: 'inside', fecha: '2026-09-11' }, { id: 'after', fecha: '2026-09-13' }
    ], getAuditOperationDate: audit => audit.fecha
  });
  assert.deepEqual(app.getFilteredAuditsForReports().map(audit => audit.id), ['inside']);
  assert.equal(app.isVisualizationMonthInRange('2026-09-01'), true);
  assert.equal(app.isVisualizationMonthInRange('2026-08-01'), false);
});

test('el filtro de país solo incluye jornadas desde octubre y se aplica al consolidado', () => {
  const ValidaFlowApp = loadAppClass();
  const app = Object.create(ValidaFlowApp.prototype);
  Object.assign(app, {
    currentView: 'visualizations', visualizationDateFrom: '', visualizationDateTo: '',
    selectedStudies: ['Tradicional'], selectedReportCountry: 'Perú',
    getReportAuditSource: () => [
      { id: '1', estudio: 'Tradicional', pais: 'PERU', fecha: '2026-10-01' },
      { id: '2', estudio: 'Tradicional', pais: 'Colombia', fecha: '2026-10-01' },
      { id: '3', estudio: 'Tradicional', pais: '604', country: 'Perú', fecha: '2026-09-30' },
      { id: '4', estudio: 'Moderno', pais: 'Perú', fecha: '2026-10-01' },
      { id: '5', estudio: 'Tradicional', fecha: '2026-10-01' },
      { id: '6', estudio: 'Tradicional', pais: 'Perú', fecha: '2026-09-30', _batchOperationDate: '2026-10-02' }
    ], getAuditOperationDate: audit => audit.fecha
  });
  assert.deepEqual(app.getFilteredAuditsForReports().map(audit => audit.id), ['1', '6']);
  app.selectedReportCountry = '__missing__';
  assert.deepEqual(app.getFilteredAuditsForReports().map(audit => audit.id), ['5']);
  assert.equal(app.getReportCountry({ pais: 'Perú', fecha: '2026-09-30' }), '');
  assert.equal(app.getReportCountry({ pais: 'Perú', fecha: '2026-09-30', _batchOperationDate: '2026-10-01' }), 'Perú');
});

test('la carga KO de octubre exige y guarda el país del archivo sin sustituirlo por el alcance', async () => {
  const modal = { hiddenByApp: false, classList: { add() { modal.hiddenByApp = true; } } };
  const document = { getElementById: id => ({
    'study-operation-date': { value: '2026-10-01' },
    'modal-select-study': modal,
    'context-project-name': { textContent: '' }
  })[id] || null };
  const ValidaFlowApp = loadAppClass(document);
  const app = Object.create(ValidaFlowApp.prototype);
  let persisted;
  const messages = [];
  Object.assign(app, {
    currentScope: { study: { id: 'study-1', name: 'Tradicional' }, country: { id: 'scope-1', code: 'GLB', name: 'Alcance interno' } },
    currentProject: 'Tradicional', currentModule: 'blocking', isSupervisor: true,
    backend: {
      configured: true,
      getPendingCarryoverSummary: async () => null,
      importDailyBatch: async args => { persisted = args; return { row_count: args.audits.length }; }
    },
    pendingUpload: { fileName: 'bloqueantes.xlsx', result: { audits: [{ id: '1', pais: '', kpis: [] }], headers: [], kpiColumns: [] } },
    getValidatorsForCurrentProject: () => [], validators: [], auditHistoryByModule: { smart: [], blocking: [] },
    refreshFromBackend: async () => {}, showToast: (message, type) => messages.push({ message, type })
  });
  await app.confirmStudyUpload();
  assert.equal(persisted, undefined);
  assert.equal(modal.hiddenByApp, false);
  assert.match(messages[0].message, /no traen un país válido/);

  app.pendingUpload.result.audits[0].pais = 'Costa Rica';
  await app.confirmStudyUpload();
  assert.equal(persisted.audits[0].pais, 'Costa Rica');
  assert.equal(persisted.audits[0].fecha, '2026-10-01');
  assert.equal(modal.hiddenByApp, true);

  persisted = undefined;
  modal.hiddenByApp = false;
  app.currentScope.country = { id: 'scope-2', code: 'PE', name: 'Perú' };
  app.pendingUpload = { fileName: 'bloqueantes.xlsx', result: { audits: [{ id: '2', pais: 'Costa Rica', kpis: [] }], headers: [], kpiColumns: [] } };
  await app.confirmStudyUpload();
  assert.equal(persisted, undefined);
  assert.equal(modal.hiddenByApp, false);
  assert.match(messages.at(-1).message, /país distinto del alcance Perú/);
});

test('los pendientes de jornadas anteriores no cuentan en el histórico ni en las asignaciones', () => {
  const ValidaFlowApp = loadAppClass();
  const app = Object.create(ValidaFlowApp.prototype);
  const oldPending = { id: 'old-pending', estudio: 'Moderno', fecha: '2026-09-19', validationStatus: 'pendiente', assignedValidatorId: 'v1' };
  const oldInProgress = { id: 'old-progress', estudio: 'Moderno', fecha: '2026-09-19', validationStatus: 'en_progreso', assignedValidatorId: 'v1' };
  const oldCompleted = { id: 'old-completed', estudio: 'Moderno', fecha: '2026-09-19', validationStatus: 'completada', assignedValidatorId: 'v1' };
  const currentPending = { id: 'today-pending', estudio: 'Moderno', fecha: '2026-09-20', validationStatus: 'pendiente', assignedValidatorId: 'v1' };
  Object.assign(app, {
    currentView: 'visualizations', currentModule: 'blocking', currentProject: 'Moderno',
    visualizationModuleFilter: 'blocking', auditHistoryByModule: { smart: [], blocking: [oldPending, oldInProgress, oldCompleted, currentPending] },
    blockingAudits: [oldPending, oldInProgress, oldCompleted, currentPending],
    audits: [oldPending, oldInProgress, oldCompleted, currentPending]
  });
  assert.equal(app.isExpiredPendingAudit(oldPending, '2026-09-20'), true);
  assert.equal(app.isExpiredPendingAudit(oldInProgress, '2026-09-20'), true);
  assert.equal(app.isExpiredPendingAudit(oldCompleted, '2026-09-20'), false);
  assert.equal(app.isExpiredPendingAudit(currentPending, '2026-09-20'), false);
  app.isExpiredPendingAudit = audit => ValidaFlowApp.prototype.isExpiredPendingAudit.call(app, audit, '2026-09-20');
  assert.deepEqual(app.getReportAuditSource().map(audit => audit.id), ['old-completed', 'today-pending']);
  assert.deepEqual(app.getAuditsForCurrentProject().map(audit => audit.id), ['old-completed', 'today-pending']);

  const validatorSource = fs.readFileSync(path.join(root, 'js/validator-ui.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export class ValidatorUI', 'class ValidatorUI');
  const context = vm.createContext({ formatNicaraguaDateTime: value => value, getNicaraguaDateKey: value => value });
  vm.runInContext(`${validatorSource}\nthis.ValidatorUI = ValidatorUI;`, context);
  const validatorUI = Object.create(context.ValidatorUI.prototype);
  Object.assign(validatorUI, { app, currentValidator: { id: 'v1' }, currentModule: 'blocking' });
  assert.deepEqual(validatorUI.getMyAudits().map(audit => audit.id), ['old-completed', 'today-pending']);
});

test('la nueva jornada no vuelve a arrastrar pendientes y el SQL protege las completadas', () => {
  const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const backendSource = fs.readFileSync(path.join(root, 'js/supabase-backend.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const cleanupSql = fs.readFileSync(path.join(root, 'supabase/sql/prune-expired-pending-audits.sql'), 'utf8');
  assert.match(appSource, /const carryoverAction = 'discard'/);
  assert.match(backendSource, /carryoverAction = 'discard'/);
  assert.doesNotMatch(html, /name="carryover-decision" value="carry"/);
  assert.match(cleanupSql, /operation_date < operation_day/);
  assert.match(cleanupSql, /a\.status <> 'completada'::public\.audit_status/);
  assert.match(cleanupSql, /row_count = \(select count\(\*\)::integer from public\.audits/);
  assert.match(cleanupSql, /if new\.carried_over_count > 0 then/);
});

test('el benchmark KO despliega países con métricas que suman el total del estudio', () => {
  const tbody = { innerHTML: '', addEventListener(name, listener) { this.onClick = listener; }, querySelectorAll: () => [] };
  const document = { getElementById: id => id === 'exec-benchmark-tbody' ? tbody : null };
  const ValidaFlowApp = loadAppClass(document);
  const app = Object.create(ValidaFlowApp.prototype);
  app.expandedBenchmarkStudies = new Set();
  app.renderUniverseDecisionBreakdown = () => {};
  const alert = name => ({ name, kpiName: name, needsReview: true });
  const audits = [
    { estudio: 'Tradicional', pais: 'Perú', fecha: '2026-10-01', kpis: [alert('A')], validationResults: { A: { status: 'aplica' } } },
    { estudio: 'Tradicional', pais: 'Colombia', fecha: '2026-10-01', kpis: [alert('B')], validationResults: { B: { status: 'no_aplica' } } },
    { estudio: 'Tradicional', pais: 'Perú', fecha: '2026-10-01', kpis: [], validationResults: {} },
    { estudio: 'Tradicional', fecha: '2026-10-01', kpis: [], validationResults: {} },
    { estudio: 'Moderno', pais: 'Perú', fecha: '2026-10-01', kpis: [alert('C')], validationResults: { C: { status: 'aplica' } } },
    { estudio: 'Tradicional', pais: 'Costa Rica', fecha: '2026-09-30', kpis: [], validationResults: {} }
  ];
  app.renderExecutiveMetrics(audits);
  assert.equal((tbody.innerHTML.match(/class="benchmark-expand-toggle"/g) || []).length, 2);
  const parentRows = tbody.innerHTML.match(/<tr class="benchmark-study-parent">[\s\S]*?<\/tr>/g) || [];
  assert.match(tbody.innerHTML, /Chile[\s\S]*?Sin datos/);
  assert.match(parentRows[0], /data-study="Tradicional"[\s\S]*?<strong>5<\/strong>[\s\S]*?2 alertas[\s\S]*?text-success">1[\s\S]*?text-magenta">1/);
  assert.match(parentRows[0], /desde oct\. 2026/);
  assert.match(parentRows[1], /data-study="Moderno"[\s\S]*?<strong>1<\/strong>[\s\S]*?1 alertas/);
  const row = (study, country) => tbody.innerHTML.match(new RegExp(`<tr[^>]+data-benchmark-parent="${study}"[^>]+data-benchmark-country="${country}"[^>]*>([\\s\\S]*?)<\\/tr>`))?.[1] || '';
  assert.match(row('Tradicional', 'Perú'), /↳ Perú[\s\S]*?<strong>2<\/strong>[\s\S]*?1 alertas[\s\S]*?text-success">1/);
  assert.match(row('Tradicional', 'Colombia'), /↳ Colombia[\s\S]*?<strong>1<\/strong>[\s\S]*?1 alertas[\s\S]*?text-magenta">1/);
  assert.match(row('Tradicional', 'Sin país'), /↳ Sin país[\s\S]*?<strong>1<\/strong>[\s\S]*?0 alertas/);
  assert.match(row('Moderno', 'Perú'), /↳ Perú[\s\S]*?<strong>1<\/strong>[\s\S]*?1 alertas/);
  assert.doesNotMatch(tbody.innerHTML, /↳ Costa Rica/);
  assert.match(tbody.innerHTML, /data-study="Tradicional" aria-expanded="false"/);
  assert.match(tbody.innerHTML, /data-benchmark-parent="Tradicional"[^>]*hidden/);
});

test('un benchmark solo histórico no muestra el desglose por país', () => {
  const tbody = { innerHTML: '' };
  const ValidaFlowApp = loadAppClass({ getElementById: id => id === 'exec-benchmark-tbody' ? tbody : null });
  const app = Object.create(ValidaFlowApp.prototype);
  app.renderUniverseDecisionBreakdown = () => {};
  app.renderExecutiveMetrics([{ estudio: 'Tradicional', pais: 'Costa Rica', fecha: '2026-09-30', kpis: [] }]);
  assert.match(tbody.innerHTML, /KO Tradicional CAM|Tradicional/);
  assert.doesNotMatch(tbody.innerHTML, /benchmark-expand-toggle|benchmark-country-row|Costa Rica/);
});

test('el filtro de país se oculta para septiembre y aparece al incluir octubre', () => {
  const row = { hidden: false };
  const select = { replaceChildren(...options) { this.options = options; }, value: 'all' };
  const context = { textContent: '' };
  const document = {
    getElementById: id => ({ 'report-country-filter-row': row, 'report-country-filter': select, 'report-country-context': context })[id] || null,
    createElement: () => ({ value: '', textContent: '' })
  };
  const ValidaFlowApp = loadAppClass(document);
  const app = Object.create(ValidaFlowApp.prototype);
  app.selectedReportCountry = 'all';
  app.getStudyAndDateFilteredAuditsForReports = () => [{ pais: 'Costa Rica', fecha: '2026-09-30' }];
  app.populateReportCountryFilter();
  assert.equal(row.hidden, true);
  assert.equal(select.options.length, 1);
  app.getStudyAndDateFilteredAuditsForReports = () => [{ pais: 'Costa Rica', fecha: '2026-10-01' }];
  app.populateReportCountryFilter();
  assert.equal(row.hidden, false);
  assert.equal(select.options[1].value, 'Costa Rica');
});

test('el control del benchmark abre y cierra únicamente las filas del estudio elegido', () => {
  const rows = [
    { dataset: { benchmarkParent: 'Tradicional' }, hidden: true },
    { dataset: { benchmarkParent: 'Tradicional' }, hidden: true },
    { dataset: { benchmarkParent: 'Moderno' }, hidden: true }
  ];
  const tbody = { addEventListener(name, listener) { this.onClick = listener; }, querySelectorAll: () => rows };
  const document = { getElementById: id => id === 'exec-benchmark-tbody' ? tbody : null };
  const ValidaFlowApp = loadAppClass(document);
  const app = Object.create(ValidaFlowApp.prototype);
  app.expandedBenchmarkStudies = new Set();
  app.initStudyFilter();
  const attributes = { 'aria-expanded': 'false' };
  const button = {
    dataset: { study: 'Tradicional' },
    getAttribute: name => attributes[name],
    setAttribute: (name, value) => { attributes[name] = value; },
    querySelector: () => ({ textContent: 'KO Tradicional CAM' })
  };
  const event = { target: { closest: () => button } };
  tbody.onClick(event);
  assert.deepEqual(rows.map(row => row.hidden), [false, false, true]);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.ok(app.expandedBenchmarkStudies.has('Tradicional'));
  tbody.onClick(event);
  assert.deepEqual(rows.map(row => row.hidden), [true, true, true]);
  assert.equal(attributes['aria-expanded'], 'false');
});

test('cada botón de informes tiene un único listener y ya no se invoca desde HTML', () => {
  const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal((appSource.match(/getElementById\('btn-export-excel'\)\?\.addEventListener/g) || []).length, 1);
  assert.equal((appSource.match(/getElementById\('btn-export-multi-sheet'\)\?\.addEventListener/g) || []).length, 1);
  assert.equal((appSource.match(/getElementById\('btn-export-executive-xlsx'\)\?\.addEventListener/g) || []).length, 1);
  assert.doesNotMatch(html, /id="btn-export-excel"[^>]*onclick=/);
  assert.doesNotMatch(html, /id="btn-export-multi-sheet"[^>]*onclick=/);
  assert.doesNotMatch(html, /id="btn-export-executive-xlsx"[^>]*onclick=/);
});

test('la interfaz comercial no ofrece descarga de PowerPoint', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data-export-commercial-ppt/);
  assert.doesNotMatch(html, /Descargar PowerPoint/);
});
