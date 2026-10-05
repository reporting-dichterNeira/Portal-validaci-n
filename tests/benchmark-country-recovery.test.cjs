const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const context = vm.createContext({ console, SUPABASE_CONFIG: {}, getStudyDisplayName: value => value,
  document: { getElementById: () => null }, formatNicaraguaDate: value => value });
for (const [file, name] of [['excel-parser.js', 'ExcelParser'], ['supabase-backend.js', 'SupabaseBackend']]) {
  const source = fs.readFileSync(path.join(root, 'js', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(`export class ${name}`, `class ${name}`);
  vm.runInContext(source + `\nthis.${name}=${name};`, context);
}
const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('// Inicializar la aplicación inmediatamente'))
  .replace(/^import .*;\r?\n/gm, '') + '\nthis.App=ValidaFlowApp;', context);
const app = () => Object.assign(Object.create(context.App.prototype), {
  adminExternalAnalysis: { alertRecords: [] }, benchmarkCountryRows: []
});
const audit = (id, pais = '', estudio = 'Tradicional') => ({ id, pais, estudio, kpis: [], fecha: '2026-09-01' });

test('país diario real tiene prioridad y normaliza Guatemala ABVO/Embocen a Guatemala', () => {
  const a = app();
  a.adminExternalAnalysis.alertRecords = [{ audit_external_id: '123', country: 'Panamá' }];
  assert.equal(a.getBenchmarkCountry(audit('123', 'Costa Rica')), 'Costa Rica');
  assert.equal(a.getBenchmarkCountry(audit('124', 'Guatemala ABVO')), 'Guatemala');
  assert.equal(a.getBenchmarkCountry(audit('125', 'EMBOCEN Guatemala')), 'Guatemala');
  assert.equal(a.getBenchmarkCountry({ ...audit('126'), meta: { 'Nombre del país': 'PA' } }), 'Panamá');
  for (const pais of ['1097', '1097.0', 'GLB', 'GROCERY SHOPPING', 'Costa Rica || Panamá']) {
    assert.equal(a.getDailyBenchmarkCountry(audit('127', pais)), '');
  }
});

test('fallback usa ID de auditoría normalizado, nunca PDV, y conserva el dato diario original', () => {
  const a = app();
  a.benchmarkCountryRows = [{ audit_external_id: '123', country: 'Panamá', study: 'ko_trad_pa_202609' },
    { audit_external_id: '900', country: 'Costa Rica' }];
  const row = { ...audit('000123.0', '1098'), idPDV: '900' };
  assert.equal(a.getBenchmarkCountry(row), 'Panamá');
  assert.equal(row.pais, '1098');
  assert.equal(a.getBenchmarkCountry({ ...audit('124'), idPDV: '900' }), '');
  assert.equal(a.getBenchmarkCountry(audit('123', '', 'Moderno')), '');
});

test('duplicados iguales son un país; cruce ambiguo no adivina ni usa un histórico obsoleto', () => {
  const a = app();
  a.benchmarkCountryRows = [{ audit_external_id: '1', country: 'Guatemala Embocen' },
    { audit_external_id: '1', country: 'Guatemala ABVO' }];
  assert.equal(a.getBenchmarkCountry(audit('1')), 'Guatemala');
  a.benchmarkCountryRows = [...a.benchmarkCountryRows, { audit_external_id: '1', country: 'Costa Rica' }];
  assert.equal(a.getBenchmarkCountry({ ...audit('1'), benchmark_country: 'Guatemala' }), '');
  assert.equal(a.getBenchmarkCountry({ ...audit('2'), benchmark_country: 'Panamá' }), 'Panamá');
});

test('históricos recuperados suman todos los totales KO y Chile/Lindley no se desglosan', () => {
  const a = app();
  const tbody = { innerHTML: '' };
  context.document.getElementById = id => id === 'exec-benchmark-tbody' ? tbody : null;
  a.renderUniverseDecisionBreakdown = () => {};
  a.benchmarkCountryRows = [{ audit_external_id: '1', country: 'Costa Rica' }];
  const alert = { name: 'A', needsReview: true };
  a.renderExecutiveMetrics([{ ...audit('1', '1097'), kpis: [alert], validationResults: { A: { status: 'aplica' } } },
    { ...audit('2', 'Panamá'), kpis: [alert], validationResults: { A: { status: 'no_aplica' } } },
    { ...audit('3', '1098'), kpis: [alert] }, audit('4', 'Chile', 'Chile'), audit('5', 'Perú', 'Lindley')]);
  const rows = [...tbody.innerHTML.matchAll(/<tr[^>]+data-benchmark-parent="Tradicional"[^>]*>([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, 3);
  const numbers = rows.map(row => [...row[1].matchAll(/<strong[^>]*>(\d+)<\/strong>/g)].map(match => +match[1]));
  assert.deepEqual(numbers.reduce((sum, row) => sum.map((n, i) => n + row[i]), [0, 0, 0]), [3, 1, 1]);
  assert.match(tbody.innerHTML, /data-study="Tradicional" aria-expanded="true"/);
  assert.doesNotMatch(tbody.innerHTML, /data-benchmark-parent="(?:Chile|Lindley)"/);
  context.document.getElementById = () => null;
});

test('carga faltantes una vez, reutiliza países disponibles y nunca consulta export para perfil comercial', async () => {
  const a = app();
  const calls = [];
  const rows = [audit('1'), audit('2', 'Costa Rica')];
  Object.assign(a, { currentRole: 'visualizer', currentProfile: {},
    backend: { configured: true, loadAuditCountryContext: async ids => { calls.push([...ids]); return [{ audit_external_id: '1', country: 'Panamá' }]; } },
    renderReportsView() {}, getReportAuditSource: () => rows });
  await Promise.all([a.ensureBenchmarkCountries(rows), a.ensureBenchmarkCountries(rows)]);
  await a.ensureBenchmarkCountries(rows);
  assert.deepEqual(calls, [['1']]);
  assert.equal(a.getBenchmarkCountry(rows[0]), 'Panamá');
  a.currentRole = 'commercial';
  await a.ensureBenchmarkCountries([audit('3')]);
  assert.equal(calls.length, 1);
});

test('consulta solo tres columnas, pagina sin perder duplicados y rechaza IDs no numéricos', async () => {
  const backend = Object.create(context.SupabaseBackend.prototype);
  const calls = [];
  backend.ensureConfigured = () => {};
  backend.client = { from(table) {
    const query = { table };
    return { select(columns) { query.columns = columns; return this; },
      in(column, ids) { query.ids = [...ids]; query.filterColumn = column; return this; },
      order() { return this; }, async range(from, to) {
        calls.push({ ...query, from, to });
        return { data: from === 0 ? Array.from({ length: 1000 }, () => ({ audit_external_id: '1', country: 'Panamá' })) : [{ audit_external_id: '1', country: 'Panamá' }], error: null };
      } };
  } };
  const result = await backend.loadAuditCountryContext(['1', '1', 'Filtros aplicados']);
  assert.equal(result.length, 1001);
  assert.deepEqual(calls.map(call => call.from), [0, 1000]);
  assert.equal(calls[0].columns, 'audit_external_id, country, study');
  assert.deepEqual(calls[0].ids, ['1']);
});

test('vista previa e informe PDF incluyen el mismo país recuperado para KO, no desglosan Lindley', () => {
  const a = app();
  const dossier = { innerHTML: '' }, print = { innerHTML: '' };
  context.document.getElementById = id => ({ 'modal-commercial-report-preview': {},
    'dossier-benchmark-tbody': dossier, 'print-benchmark-tbody': print })[id] || null;
  Object.assign(a, { selectedStudies: ['ALL'], selectedReportCountry: 'all',
    renderUniverseDecisionBreakdown() {}, getFilteredAuditsForReports: () => [
      { ...audit('1', '1097'), benchmark_country: 'Costa Rica' }, audit('2', 'Perú', 'Lindley')
    ] });
  a.openCommercialReportPreview(false);
  assert.equal(dossier.innerHTML, print.innerHTML);
  assert.match(print.innerHTML, /↳ Costa Rica/);
  assert.doesNotMatch(print.innerHTML, /↳ Perú/);
  context.document.getElementById = () => null;
});
