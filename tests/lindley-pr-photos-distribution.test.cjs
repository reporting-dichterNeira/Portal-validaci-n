const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({ console, SUPABASE_CONFIG: {}, document: { getElementById: () => null } });
for (const [file, className] of [['excel-parser.js', 'ExcelParser'], ['distributor.js', 'Distributor']]) {
  const source = fs.readFileSync(path.join(root, 'js', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(`export class ${className}`, `class ${className}`);
  vm.runInContext(`${source}\nthis.${className} = ${className};`, context);
}
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
vm.runInContext(appSource.slice(0, appSource.indexOf('// Inicializar la aplicación inmediatamente'))
  .replace(/^import .*;\r?\n/gm, '') + '\nthis.ValidaFlowApp = ValidaFlowApp;', context);
const { ExcelParser, Distributor, ValidaFlowApp } = context;
const validators = ['A', 'B', 'C'].map(id => ({ id, estudio: 'Lindley' }));
const audit = (id, photos, count = 1) => ({ id: String(id), cantidadFotosPR: photos, kpis: Array.from({ length: count }, () => ({ needsReview: true })) });
const spread = values => Math.max(...values) - Math.min(...values);

test('Cantidad_de_fotos_PR se importa como cantidad y sobrevive al guardado y lectura', () => {
  const parsed = ExcelParser.parseCSV('ID_de_audito;Tipo;Cantidad_de_fotos_PR;ID_PDV;Alerta pop\n5527124;Photo Recognition;17;900;Revisar\n5527959;Manuales;0;901;Revisar');
  assert.equal(parsed.audits[0].cantidadFotosPR, 17);
  assert.equal(parsed.audits[1].cantidadFotosPR, 0);
  assert.equal(parsed.audits[0].id, '5527124');
  const backendSource = fs.readFileSync(path.join(root, 'js/supabase-backend.js'), 'utf8');
  vm.runInContext(backendSource.slice(0, backendSource.indexOf('export class SupabaseBackend'))
    .replace(/^import .*;\r?\n/gm, ''), context);
  const row = context.auditToRow(parsed.audits[0], 'smart', null);
  const restored = context.mapAudit(JSON.parse(JSON.stringify(row)));
  assert.equal(restored.cantidadFotosPR, 17);
  assert.equal(Distributor.getPrPhotoCount({ meta: { ' Cantidad de fotos PR ': '6' } }), 6);
  for (const invalid of ['', null, 'texto', -2, 1.5, Infinity]) {
    assert.equal(Distributor.getPrPhotoCount({ cantidadFotosPR: invalid }), 0);
  }
});

test('Smart Lindley equilibra la suma de fotos PR conservando IDs, orden y total de auditorías', () => {
  const input = [17, 9, 6, 6, 5, 4, 4, 2, 2, 0, 0, 0].map((photos, id) => audit(id, photos));
  const before = JSON.stringify(input);
  const result = Distributor.distribute(input, validators, { balanceByPrPhotos: true });
  const stats = Distributor.getValidatorStats(result, validators, { balanceByPrPhotos: true });
  assert.equal(spread(stats.map(val => val.totalAssigned)), 0);
  assert.equal(spread(stats.map(val => val.totalAssignedKpis)), 0);
  assert.ok(spread(stats.map(val => val.totalAssignedPrPhotos)) <= 2);
  assert.equal(stats.reduce((sum, val) => sum + val.totalAssignedPrPhotos, 0), 55);
  assert.deepEqual(Array.from(result, item => item.id), input.map(item => item.id));
  assert.equal(JSON.stringify(input), before);
});

test('fotos y KPIs influyen en el reparto, mientras Tipo no cambia la asignación', () => {
  const input = [audit(1, 20, 1), audit(2, 20, 1), audit(3, 0, 20), audit(4, 0, 20)];
  const team = validators.slice(0, 2);
  const result = Distributor.distribute(input, team, { balanceByPrPhotos: true });
  const stats = Distributor.getValidatorStats(result, team, { balanceByPrPhotos: true });
  assert.equal(spread(stats.map(val => val.totalAssignedPrPhotos)), 0);
  assert.equal(spread(stats.map(val => val.totalAssignedKpis)), 0);
  const withTypes = input.map((item, index) => ({ ...item, tipo: index % 2 ? 'Manuales' : 'Photo Recognition' }));
  const changedTypes = Distributor.distribute(withTypes, team, { balanceByPrPhotos: true });
  assert.deepEqual(Array.from(changedTypes, item => item.assignedValidatorId), Array.from(result, item => item.assignedValidatorId));
  const noPhotos = [10, 9, 8, 3, 2, 1].map((count, id) => audit(id, 0, count));
  const noPhotosStats = Distributor.getValidatorStats(Distributor.distribute(noPhotos, validators, { balanceByPrPhotos: true }), validators);
  assert.equal(spread(noPhotosStats.map(val => val.totalAssignedKpis)), 0);
});

test('los totales de auditorías difieren como máximo en uno y se conservan todas las fotos', () => {
  for (let validatorCount = 1; validatorCount <= 8; validatorCount++) {
    const team = Array.from({ length: validatorCount }, (_, id) => ({ id }));
    for (let size = 1; size <= 100; size++) {
      const input = Array.from({ length: size }, (_, id) => audit(id, id % 18, 1 + id % 9));
      const result = Distributor.distribute(input, team, { balanceByPrPhotos: true });
      const stats = Distributor.getValidatorStats(result, team, { balanceByPrPhotos: true });
      assert.ok(spread(stats.map(val => val.totalAssigned)) <= 1);
      assert.equal(stats.reduce((sum, val) => sum + val.totalAssignedPrPhotos, 0), input.reduce((sum, item) => sum + item.cantidadFotosPR, 0));
    }
  }
});

test('solo Smart Lindley activa fotos PR y la redistribución conserva completadas y en progreso', () => {
  const app = Object.create(ValidaFlowApp.prototype);
  for (const module of ['smart', 'blocking']) {
    for (const study of ['Lindley', 'Chile', 'Tradicional', 'Moderno']) {
      app.currentModule = module;
      app.currentProject = study;
      assert.equal(app.getDistributionOptions().balanceByPrPhotos, module === 'smart' && study === 'Lindley');
    }
  }
  app.currentModule = 'smart';
  app.currentProject = 'Lindley';
  const completed = { ...audit(100, 10), assignedValidatorId: 'C', validationStatus: 'completada' };
  const inProgress = { ...audit(101, 10), assignedValidatorId: 'B', validationStatus: 'en_progreso' };
  app.audits = [completed, inProgress, ...Array.from({ length: 12 }, (_, id) => ({ ...audit(id, 3, 2), validationStatus: 'pendiente' }))];
  app.getAuditsForCurrentProject = () => app.audits;
  app.getValidatorsForCurrentProject = () => validators;
  app.redistributePendingAudits();
  assert.equal(app.audits[0], completed);
  assert.equal(app.audits[1], inProgress);
  const stats = Distributor.getValidatorStats(app.audits.slice(2), validators, { balanceByPrPhotos: true });
  for (const val of stats) assert.equal(val.totalAssignedPrPhotos, 12);
});
