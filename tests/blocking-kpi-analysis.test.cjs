const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const elements = new Map();
const context = vm.createContext({ console, document: { getElementById: id => elements.get(id) || null }, getStudyDisplayName: value => value });
vm.runInContext(fs.readFileSync(path.join(root, 'js/blocking-kpi-analysis.js'), 'utf8').replace(/^export /gm, ''), context);
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
vm.runInContext(app.slice(0, app.indexOf('// Inicializar la aplicación inmediatamente')).replace(/^import .*;\r?\n/gm, '') + '\nthis.App = ValidaFlowApp;', context);
const fixture = [{ id: '101', idPDV: '500', estudio: 'Tradicional', fecha: '2026-10-01', pais: 'Perú',
  kpis: [
    { name: 'Rack', kpiName: 'Rack', needsReview: true, prevVal: '66,75', actualVal: '33,375', variation: '-50', criterio: 'Si varia - 15 puntos' },
    { name: 'Rack (STILLS)', kpiName: 'Rack', modelo: 'STILLS', needsReview: true, prevVal: '50', actualVal: '0', variation: '-100' },
    { name: 'Sin dato', needsReview: true, prevVal: '', actualVal: '0' },
    { name: 'Sin alerta', needsReview: false, prevVal: '100', actualVal: '100' }
  ], validationResults: { Rack: { status: 'aplica', tipificacion: 'Correcto' }, 'Rack (STILLS)': { status: 'no_aplica', tipificacion: 'Lectura' } } }];
const describe = audit => ({ study: audit.estudio, date: audit.fecha, country: audit.pais });

test('el detalle conserva decisiones por modelo y distingue puntos de porcentajes', () => {
  const rows = context.buildBlockingKpiRows(fixture, describe);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].decision, 'aplica');
  assert.equal(rows[0].previous, 66.75);
  assert.equal(rows[0].current, 33.375);
  assert.equal(rows[0].difference, -33.375);
  assert.equal(rows[0].variation, -50);
  assert.equal(rows[1].decision, 'no_aplica');
  assert.equal(rows[1].current, 0);
  assert.equal(rows[1].difference, -50);
  assert.equal(rows[2].difference, null);
  assert.equal(rows[2].decision, 'pendiente');
  for (const value of ['', null, undefined, '—', 'abc', Infinity]) assert.equal(context.parseBlockingScore(value), null);
});

test('filtros combinados por KPI, decisión, ID y diferencia son inclusivos y no inventan notas', () => {
  const rows = context.buildBlockingKpiRows(fixture, describe);
  const selected = context.filterBlockingKpiRows(rows, { kpi: 'Rack', decision: 'no_aplica', search: '500', minDifference: '-50', maxDifference: '-50' });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].model, 'STILLS');
  assert.equal(context.filterBlockingKpiRows(rows, { search: 'no-existe' }).length, 0);
  assert.equal(context.filterBlockingKpiRows(rows, { minDifference: '0' }).length, 0);
  const summary = context.summarizeBlockingKpiRows(rows);
  assert.equal(summary[0].averageDifference, -33.375);
  assert.equal(summary[2].count, 1);
  assert.equal(summary[2].scoredCount, 0);
  assert.equal(summary[2].averageDifference, null);
});

test('CSV contiene todas las filas filtradas, notas cero y celdas vacías sin fórmula ejecutable', () => {
  const rows = context.buildBlockingKpiRows(fixture, describe);
  rows[0].criterion = '=1+1';
  const csv = context.blockingKpiRowsToCsv(rows);
  assert.match(csv, /^\uFEFF"ID Auditoría"/);
  assert.equal(csv.split('\r\n').length, 4);
  assert.ok(csv.includes('"33.375";"-33.375";"-50"'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"";"0";"";""'));
});

test('usa el histórico Bloqueantes completo y respeta filtros de estudio, país y fecha', () => {
  const instance = Object.create(context.App.prototype);
  instance.auditHistoryByModule = { blocking: [...fixture,
    { ...fixture[0], id: '102', estudio: 'Chile' },
    { ...fixture[0], id: '103', fecha: '2026-09-30' },
    { ...fixture[0], id: '104', pais: 'Colombia' }] };
  instance.blockingAudits = [];
  instance.selectedStudies = ['Tradicional'];
  instance.selectedReportCountry = 'Perú';
  instance.getStudyForAudit = audit => audit.estudio;
  instance.getAuditOperationDate = audit => audit.fecha;
  instance.isWithinVisualizationDateRange = date => date === '2026-10-01';
  instance.isCountryReportPeriod = () => true;
  instance.getReportCountry = audit => audit.pais;
  instance.refreshBlockingKpiAnalysisRows();
  assert.equal(instance.blockingKpiRows.length, 3);
  assert.ok(instance.blockingKpiRows.every(row => row.auditId === '101'));
});

test('tabla pagina 100 filas, escapa HTML y no convierte notas ausentes en cero', () => {
  const instance = Object.create(context.App.prototype);
  instance.blockingKpiRows = context.buildBlockingKpiRows(fixture, describe);
  instance.blockingKpiRows[0].criterion = '<img src=x onerror=alert(1)>';
  instance.blockingKpiRows = Array.from({ length: 205 }, (_, index) => ({ ...instance.blockingKpiRows[index % 3], auditId: String(index) }));
  instance.blockingKpiFilters = {};
  instance.blockingKpiPage = 3;
  for (const id of ['blocking-kpi-tbody', 'blocking-kpi-summary', 'blocking-kpi-count', 'blocking-kpi-prev', 'blocking-kpi-next', 'blocking-kpi-download']) elements.set(id, {});
  instance.renderBlockingKpiAnalysis();
  assert.equal(elements.get('blocking-kpi-tbody').innerHTML.match(/<tr>/g).length, 5);
  assert.ok(elements.get('blocking-kpi-tbody').innerHTML.includes('&lt;img'));
  assert.ok(elements.get('blocking-kpi-tbody').innerHTML.includes('<td>—</td>'));
  assert.equal(elements.get('blocking-kpi-next').disabled, true);
  assert.equal(elements.get('blocking-kpi-prev').disabled, false);
  assert.match(elements.get('blocking-kpi-count').textContent, /Página 3 de 3/);
});
