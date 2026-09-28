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

function loadAppClass() {
  const rawSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const source = rawSource
    .slice(0, rawSource.indexOf('// Inicializar la aplicación inmediatamente'))
    .replace(/^import .*;\r?\n/gm, '');
  const document = { getElementById: () => null };
  const context = vm.createContext({
    window: { setTimeout }, document, console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    BroadcastChannel: class { postMessage() {} close() {} },
    SAMPLE_CSV_DATA: '', BLOCKING_ALERTS_SAMPLE_CSV: '', DEFAULT_VALIDATORS: [], DEFAULT_TIPIFICACIONES: [],
    TIPIFICACIONES_POR_DECISION: {}, seedSampleValidations: () => {},
    ExcelParser: { cleanDateOnly: value => String(value || '').slice(0, 10) },
    getStudyDisplayName: value => value, loadPowerPointEngine: () => {}, buildExecutivePowerPoint: () => {},
    Distributor: class {}, ValidatorUI: class {}, SupabaseBackend: class {},
    formatNicaraguaDate: value => value, formatNicaraguaDateTime: value => value,
    getNicaraguaDateKey: value => String(value || '').slice(0, 10)
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
