const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const elements = new Map();
const document = { getElementById: id => elements.get(id) || null, querySelectorAll: () => [] };
const ctx = vm.createContext({ console, document, Date, setTimeout, clearTimeout, SUPABASE_CONFIG: {},
  getNicaraguaDateKey: () => '2026-10-08', formatNicaraguaDate: value => value,
  getStudyDisplayName: value => value, ExcelParser: { normalizeAuditId: value => String(value), cleanDateOnly: value => String(value || '').slice(0, 10) } });
const backendSource = fs.readFileSync(path.join(root, 'js/supabase-backend.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class');
vm.runInContext(backendSource + '\nthis.Backend=SupabaseBackend;', ctx);
const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('// Inicializar la aplicación inmediatamente')).replace(/^import .*;\r?\n/gm, '') + '\nthis.App=ValidaFlowApp;', ctx);
function app() {
  const calls = [];
  const a = Object.assign(Object.create(ctx.App.prototype), {
    currentRole: 'visualizer', currentProfile: { id: 'test' }, currentView: 'visualizations', visualizationTab: 'alerts',
    adminExternalAnalysis: { imports: [], alertRecords: [], editRecords: [], noteScoreRecords: [] },
    adminAnalysisResourcePromises: {}, adminAnalysisResourceLoadedAt: {}, adminAnalysisResourceVersions: {},
    adminExternalAnalysisCacheMs: 120000, auditHistoryByModule: { smart: null, blocking: null },
    hydrateAdminExternalAnalysisCache: async () => false, persistAdminExternalAnalysisCache: async () => {},
    renderAdminExternalAnalysis() {}, backend: { configured: true,
      loadAdminAnalysisImports: async () => [{ dataset_type: 'alerts', row_count: 12, imported_at: '2026-10-08' }],
      loadAdminExternalAnalysis: async opts => { calls.push(opts); return { alertRecords: opts.includeAlerts ? [{ audit_external_id: '1' }] : [], editRecords: opts.includeEdits ? [{ audit_external_id: '2' }] : [] }; },
      loadAdminNoteScoreImports: async () => [{ period_month: '2026-09-01', row_count: 10 }],
      loadAdminNoteScoreAnalysis: async opts => { calls.push({ notes: opts }); return { noteScoreImports: [], noteScoreRecords: [{ subkpi: 'test' }] }; },
      loadAuditHistory: async () => { calls.push('history'); return [{ id: '1', _module: 'smart', validationStatus: 'completada', kpis: [] }]; }
    }
  });
  return { a, calls };
}

test('cada pestaña carga solo sus dependencias, comparte histórico y no pisa otras bases', async () => {
  const { a, calls } = app();
  await Promise.all([a.refreshAdminExternalAnalysis(), a.refreshAdminExternalAnalysis()]);
  assert.equal(calls.filter(x => x === 'history').length, 1);
  assert.equal(calls.filter(x => typeof x === 'object').length, 1);
  assert.equal(calls.find(x => typeof x === 'object').includeEdits, false);
  assert.equal(a.auditHistoryByModule.smart.length, 1);
  a.visualizationTab = 'editions';
  await a.refreshAdminExternalAnalysis();
  assert.equal(a.adminExternalAnalysis.alertRecords.length, 1);
  assert.equal(a.adminExternalAnalysis.editRecords.length, 1);
  assert.equal(calls.filter(x => x === 'history').length, 1);
  assert.equal(calls.some(x => x?.notes), false);
  a.visualizationTab = 'score-changes';
  await a.refreshAdminExternalAnalysis();
  assert.equal(calls.find(x => x?.notes).notes.periodMonth, '2026-09-01');
});

test('al vencer la caché se comprueban metadatos sin descargar de nuevo bases sin cambios', async () => {
  const { a, calls } = app();
  await a.refreshAdminExternalAnalysis();
  a.adminAnalysisResourceLoadedAt.alerts = 1;
  await a.refreshAdminExternalAnalysis();
  assert.equal(calls.filter(x => typeof x === 'object').length, 1);
  await a.refreshAdminExternalAnalysis({ force: true });
  assert.equal(calls.filter(x => typeof x === 'object').length, 2);
});

test('Seguimiento diario no solicita exports, notas ni histórico', async () => {
  const { a, calls } = app();
  a.visualizationTab = 'overview';
  await a.refreshAdminExternalAnalysis();
  assert.deepEqual(calls, []);
  a.renderAdministratorProductivity = () => calls.push('daily');
  a.renderReportsView = () => calls.push('reports');
  a.renderCurrentDataViews();
  assert.deepEqual(calls, ['daily']);
});

test('Ediciones pagina 100 filas, permite llegar al final y enlaza botones una sola vez', () => {
  elements.clear();
  for (const id of ['admin-editions-page-prev', 'admin-editions-page-next', 'admin-editions-page-status']) {
    elements.set(id, { dataset: {}, addEventListener() { this.listeners = (this.listeners || 0) + 1; } });
  }
  const { a } = app();
  const rows = Array.from({ length: 10005 }, (_, id) => ({ id }));
  assert.equal(a.getAdminEditionPageRows(rows).length, 100);
  a.adminEditionPage = 101;
  assert.equal(a.getAdminEditionPageRows(rows).length, 5);
  assert.equal(elements.get('admin-editions-page-next').disabled, true);
  assert.equal(elements.get('admin-editions-page-prev').listeners, 1);
  a.getAdminEditionPageRows([]);
  assert.equal(a.adminEditionPage, 1);
  elements.clear();
});

test('el histórico conserva pendientes y excluye solo las retiradas', () => {
  const { a } = app();
  a.validators = [];
  const audit = (id, status, extra = {}) => ({ id, assignedValidatorId: 'v1', _module: 'smart', _validatorName: 'Ana',
    _batchOperationDate: '2026-10-08', validationStatus: status, ...extra });
  const rows = a.summarizeValidatorHistory([
    audit('1', 'completada', { durationSeconds: 0 }), audit('2', 'completada', { durationSeconds: 10 }),
    audit('3', 'en_progreso'), audit('4', 'pendiente'),
    audit('5', 'pendiente', { _batchOperationDate: '2026-10-07', _pendingResolution:'removed' }),
    audit('6', 'completada', { assignedValidatorId: 'v2' })
  ], { dateFrom: '2026-10-01', dateTo: '2026-10-08', validatorId: 'v1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalAudits, 4);
  assert.equal(rows[0].completedAudits, 2);
  assert.equal(rows[0].pendingAudits, 1);
  assert.equal(rows[0].inProgressAudits, 1);
  assert.equal(rows[0].timedAudits, 2);
  assert.equal(rows[0].averageDurationSeconds, 5);
});

test('productividad diaria cuenta solo la última base, pagina y excluye retiradas',async()=>{
 const b=Object.create(ctx.Backend.prototype);b.ensureConfigured=()=>{};
 const cursors=[],batches=[];
 b.client={from(table){let cursor=0;return {
  select(){return this;},order(){return this;},eq(){return this;},in(col,ids){if(table==='audits')batches.push([...ids]);return this;},
  gt(col,v){cursor=v;return this;},limit(){cursors.push(cursor);return Promise.resolve({data:Array.from({length:cursor===0?1000:25},(_,i)=>({id:cursor+i+1,batch_id:2,pending_resolution:cursor+i+1===1001?'removed':null})),error:null});},
  then(resolve){return Promise.resolve({data:table==='upload_batches'?[{id:2,study_id:'s',country_id:'c',module:'blocking'},{id:1,study_id:'s',country_id:'c',module:'blocking'}]:[],error:null}).then(resolve);}
 };},rpc(name,params){assert.deepEqual([...params.p_batch_ids],[2]);return Promise.resolve({data:[],error:null});}};
 const result=await b.loadAdministration({operationDate:'2026-10-08'});
 assert.equal(result.batches.length,1);assert.equal(result.batches[0].id,2);assert.equal(result.audits.length,1024);
 assert.deepEqual(cursors,[0,1000]);assert.deepEqual(batches,[[2],[2]]);
});

test('loadState pagina auditorías activas y conserva la jornada en más de 1000 registros', async () => {
  const b = Object.create(ctx.Backend.prototype);
  b.ensureConfigured = () => {};
  const pages = [];
  b.client = { from(table) {
    let cursor = 0;
    return { select() { return this; }, order() { return this; }, eq() { return this; }, in() { return this; },
      gt(col, value) { cursor = value; return this; },
      limit() { pages.push(cursor); return Promise.resolve({ data: Array.from({ length: cursor === 0 ? 1000 : 505 }, (_, i) => ({
        id: cursor + i + 1, external_id: String(cursor + i + 1), module: 'smart', upload_batches: { operation_date: '2026-10-08' } })), error: null }); },
      then(resolve) { return Promise.resolve({ data: table === 'validators' ? [] : [{ id: 'batch' }], error: null }).then(resolve); }
    };
  } };
  const result = await b.loadState();
  assert.equal(result.smartAudits.length, 1505);
  assert.equal(result.smartAudits[1504].fecha, '2026-10-08');
  assert.deepEqual(pages, [0, 1000]);
});

test('la paginación y el conteo de notas filtran el mismo mes, sin pérdida de filas', async () => {
  const b = Object.create(ctx.Backend.prototype);
  b.ensureConfigured = () => {};
  const queries = [];
  b.client = { from() {
    const query = {};
    return { select(col, opts) { query.count = !!opts; return this; }, order() { return this; },
      eq(col, value) { query.month = value; return this; },
      range(from) { queries.push({ ...query, from }); return Promise.resolve({ data: Array.from({ length: from === 0 ? 1000 : 3 }, (_, i) => ({ id: from + i })), error: null }); },
      then(resolve) { queries.push(query); return Promise.resolve({ count: 1003, error: null }).then(resolve); }
    };
  } };
  const rows = await b.loadAllAdminAnalysisRows('admin_note_score_records', 'id', { periodMonth: '2026-09-01' });
  assert.equal(rows.length, 1003);
  assert.ok(queries.every(query => query.month === '2026-09-01'));
});

test('consultas simultáneas de estado comparten una sola solicitud', async () => {
  const { a } = app();
  let loads = 0;
  a.loadBackendStateAndRender = async () => { loads++; await new Promise(resolve => setTimeout(resolve, 5)); };
  await Promise.all([a.refreshFromBackend(), a.refreshFromBackend()]);
  assert.equal(loads, 1);
});

test('la caché histórica no reemplaza avances activos recién leídos', async () => {
  const { a } = app();
  delete a.hydrateAdminExternalAnalysisCache;
  a.smartAudits = [{ id: '1', _rowId: 'row1', _module: 'smart', validationStatus: 'completada', kpis: [] }];
  a.blockingAudits = [];
  a.readAdminExternalAnalysisCache = async () => ({ savedAt: Date.now(), analysis: { platformAudits: [
    { id: '1', _rowId: 'row1', _module: 'smart', validationStatus: 'pendiente' },
    { id: '2', _rowId: 'row2', _module: 'blocking', validationStatus: 'completada' }
  ] } });
  await a.hydrateAdminExternalAnalysisCache();
  assert.equal(a.adminExternalAnalysis.platformAudits.length, 2);
  assert.equal(a.auditHistoryByModule.smart[0].validationStatus, 'completada');
});

test('un cambio de mes de notas evita reutilizar filas del mes anterior', async () => {
  const { a, calls } = app();
  a.adminScoreChangeCurrentMonth = '2026-09-01';
  await a.ensureAdminAnalysisResource('notes');
  a.adminScoreChangeCurrentMonth = '2026-08-01';
  await a.ensureAdminAnalysisResource('notes');
  assert.deepEqual(calls.filter(x => x?.notes).map(x => x.notes.periodMonth), ['2026-09-01', '2026-08-01']);
});

test('abrir indicadores de Bloqueantes carga también Smart validado del histórico y reutiliza ambas consultas', async () => {
  const { a } = app();
  const loads = [];
  Object.assign(a, { visualizationTab: 'metrics', visualizationModuleFilter: 'blocking', currentModule: 'blocking',
    auditHistoryLoadPromises: { smart: null, blocking: null }, smartAudits: [], blockingAudits: [],
    moveReportsContent() {}, renderReportsView() {}, renderCurrentDataViews() {}, setHistoryDateRangeFromAudits() {},
    isExpiredPendingAudit: () => false,
    backend: { configured: true, async loadAuditHistory({ module }) {
      loads.push(module);
      return [{ id: '42', _module: module, estudio: 'Chile', fecha: '2026-10-01', validationStatus: 'completada',
        kpis: [{ name: 'Precio', needsReview: true }], validationResults: { Precio: { status: 'aplica' } } }];
    } }
  });
  await a.switchVisualizationTab('metrics');
  assert.deepEqual(loads.sort(), ['blocking', 'smart']);
  assert.equal(a.getReportAuditSource('smart', 'smart')[0].validationStatus, 'completada');
  assert.equal(a.getReportAuditSource().length, 1);
  let receiptAudits;
  ctx.PortalIndicators = { canonical: rows => rows, render: (_app, _rows, _history, _prepared, receipts) => receiptAudits = receipts };
  Object.assign(a, { selectedStudies: ['ALL'], selectedReportCountry: 'all', reportsSubtab: 'operational',
    populateStudyPills() {}, populateReportCountryFilter() {}, renderClassicReports() {}, ensureBenchmarkCountries() {} });
  try {
    ctx.App.prototype.renderReportsView.call(a);
    assert.deepEqual(Array.from(receiptAudits, row => row._module).sort(), ['blocking', 'smart']);
  } finally { delete ctx.PortalIndicators; }
  await a.setVisualizationModuleFilter('smart');
  assert.equal(loads.length, 2);
  await a.ensureIndicatorHistoriesLoaded({ force: true });
  assert.equal(loads.length, 4);
});

test('un alcance de supervisor no consulta módulos ajenos', async () => {
  const { a } = app();
  a.currentScope = { module: 'blocking' };
  const modules = [];
  a.ensureHistoricalReportsLoaded = async ({ module }) => modules.push(module);
  await a.ensureIndicatorHistoriesLoaded();
  assert.deepEqual(modules, ['blocking']);
});

test('filtros de métricas combinan país real, estudio y módulo; conservan opciones y filtran el histórico', async () => {
  const { a } = app();
  const rows = [
    {id:'1',estudio:'Chile',pais:'Chile',region:'Norte',fecha:'2026-08-01',_module:'blocking'},
    {id:'2',estudio:'Moderno',pais:'Panamá',fecha:'2026-10-01',_module:'blocking'},
    {id:'3',estudio:'Moderno',pais:'Panamá',fecha:'2026-10-01',_module:'smart'},
    {id:'4',estudio:'Moderno',pais:'Costa Rica',fecha:'2026-10-01',_module:'smart'},
    {id:'5',estudio:'Lindley',pais:'Perú',region:'Lima',fecha:'2026-10-01',_module:'blocking'}
  ];
  Object.assign(a, {selectedStudies:['ALL'],selectedReportCountry:'all',selectedMetricsCountry:'all',visualizationModuleFilter:'all',currentModule:'blocking',
    auditHistoryByModule:{smart:rows.filter(r=>r._module==='smart'),blocking:rows.filter(r=>r._module==='blocking')},
    isExpiredPendingAudit:()=>false,renderReportsView(){},renderDailyReportsView(){},updateVisualizationModuleControls(){},renderCurrentDataViews(){},
    visualizationTab:'metrics',ensureIndicatorHistoriesLoaded:async()=>{},getStudyForAudit:r=>r.estudio,
    getAuditOperationDate:r=>r.fecha,getReportCountry:r=>r.pais,getReportGeography:r=>r.region||r.pais });
  await a.setMetricsScopeFilter('country','Panamá');await a.setMetricsScopeFilter('study','Moderno');await a.setMetricsScopeFilter('module','smart');
  assert.deepEqual(Array.from(a.getFilteredAuditsForReports(),r=>r.id),['3']);
  assert.deepEqual(Array.from(a.getCommitteeHistoryForReports(),r=>r.id),['3']);
  assert.ok(a.getMetricsScopeOptions().countries.some(r=>r.value==='Chile'));
  await a.setMetricsScopeFilter('study','Chile');await a.setMetricsScopeFilter('country','Chile');await a.setMetricsScopeFilter('module','blocking');
  assert.deepEqual(Array.from(a.getFilteredAuditsForReports(),r=>r.id),['1']);
  a.visualizationDateFrom='2026-10-01';assert.equal(a.getFilteredAuditsForReports().length,0);
  assert.equal(a.getCommitteeHistoryForReports().length,1);
  await a.setMetricsScopeFilter('study','all');await a.setMetricsScopeFilter('country','Perú');
  assert.deepEqual(Array.from(a.getFilteredAuditsForReports(),r=>r.id),['5']);
});

test('mes y rango de fechas se combinan para jornadas y descargas; evolución conserva contexto', async () => {
  const { a } = app();
  const rows = ['2026-09-15', '2026-10-01', '2026-10-08', '2026-10-20'].map((fecha, i) =>
    ({ id: String(i), fecha, estudio: 'Moderno', pais: 'Panamá', _module: 'blocking' }));
  let dailyRenders = 0;
  Object.assign(a, { selectedStudies: ['ALL'], selectedReportCountry: 'all', selectedMetricsCountry: 'all',
    visualizationTab: 'metrics', visualizationModuleFilter: 'blocking', visualizationDateFrom: '', visualizationDateTo: '',
    getReportAuditSource: () => rows, getAuditOperationDate: r => r.fecha, getStudyForAudit: r => r.estudio,
    getReportCountry: r => r.pais, getReportGeography: r => r.pais, renderReportsView() {},
    renderDailyReportsView() { dailyRenders++; }, renderCurrentDataViews() {}, showToast() {} });
  await a.setMetricsScopeFilter('month', '2026-10');
  await a.setMetricsScopeFilter('from', '2026-09-01');
  await a.setMetricsScopeFilter('to', '2026-10-08');
  assert.deepEqual(Array.from(a.getFilteredAuditsForReports(), r => r.fecha), ['2026-10-01', '2026-10-08']);
  assert.deepEqual(Array.from(a.getFilteredAuditsForReports(rows, { ignoreMonth: true }), r => r.fecha),
    ['2026-09-15', '2026-10-01', '2026-10-08']);
  assert.equal(a.getCommitteeHistoryForReports().length, 4);
  assert.ok(a.getMetricsScopeOptions().months.some(r => r.value === '2026-09'));
  await a.setMetricsScopeFilter('month', '2026-08');
  assert.equal(a.getFilteredAuditsForReports().length, 0);
  assert.ok(a.getMetricsScopeOptions().months.some(r => r.value === '2026-08'));
  await a.setMetricsScopeFilter('dates-clear', '');
  assert.equal(a.visualizationDateFrom, ''); assert.equal(a.visualizationDateTo, '');
  assert.equal(a.selectedMetricsMonth, '2026-08');
  assert.ok(dailyRenders >= 5);
});

test('accesos directo diario y métricas conservan restricciones comerciales', () => {
  const { a } = app();
  a.renderReportsView = () => {};
  a.switchReportsSubtab('daily'); assert.equal(a.reportsSubtab, 'daily');
  a.switchReportsSubtab('executive'); assert.equal(a.reportsSubtab, 'metrics');
  a.switchReportsSubtab('operational'); assert.equal(a.reportsSubtab, 'metrics');
  a.currentRole = 'commercial';
  a.switchReportsSubtab('daily'); assert.equal(a.reportsSubtab, 'metrics');
});
