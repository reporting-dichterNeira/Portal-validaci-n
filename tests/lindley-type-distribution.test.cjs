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
const audit = (id, tipo, count) => ({ id: String(id), tipo, kpis: Array.from({ length: count }, () => ({ needsReview: true })) });
const spread = values => Math.max(...values) - Math.min(...values);

test('Tipo se importa y sobrevive al guardado y lectura del payload de auditoría', () => {
  const parsed = ExcelParser.parseCSV('ID_de_audito; Tipo ;ID_PDV;Alerta pop\n5527124; Photo   Recognition ;900;Revisar\n5527959;Manuales;901;Revisar');
  assert.equal(parsed.audits[0].tipo, 'Photo Recognition');
  assert.equal(parsed.audits[1].tipo, 'Manuales');
  assert.equal(parsed.audits[0].id, '5527124');
  const backendSource = fs.readFileSync(path.join(root, 'js/supabase-backend.js'), 'utf8');
  vm.runInContext(backendSource.slice(0, backendSource.indexOf('export class SupabaseBackend'))
    .replace(/^import .*;\r?\n/gm, ''), context);
  const row = context.auditToRow(parsed.audits[0], 'smart', null);
  const restored = context.mapAudit(JSON.parse(JSON.stringify(row)));
  assert.equal(restored.tipo, 'Photo Recognition');
  assert.equal(Distributor.getAuditType({ meta: { ' TIPO ': 'photo  recognition' } }).key, 'photo recognition');
});

test('Smart Lindley equilibra cada tipo, el total y los KPIs conservando IDs y orden', () => {
  const input = [audit(1, 'Manuales', 10), audit(2, 'Manuales', 9), audit(3, 'Manuales', 1),
    audit(4, 'Photo Recognition', 10), audit(5, 'Photo Recognition', 9), audit(6, 'Photo Recognition', 1)];
  const before = JSON.stringify(input);
  const result = Distributor.distribute(input, validators, { balanceByType: true });
  const stats = Distributor.getValidatorStats(result, validators, { balanceByType: true });
  assert.equal(spread(stats.map(val => val.totalAssigned)), 0);
  assert.ok(spread(stats.map(val => val.totalAssignedKpis)) <= 7);
  for (const val of stats) {
    assert.equal(val.auditTypes.find(type => type.label === 'Manuales').count, 1);
    assert.equal(val.auditTypes.find(type => type.label === 'Photo Recognition').count, 1);
  }
  assert.deepEqual(Array.from(result, item => item.id), input.map(item => item.id));
  assert.equal(JSON.stringify(input), before);
});

test('cuotas por tipo y totales difieren como máximo en uno con restos y tipos vacíos', () => {
  for (let validatorCount = 1; validatorCount <= 8; validatorCount++) {
    const team = Array.from({ length: validatorCount }, (_, id) => ({ id }));
    for (let size = 1; size <= 100; size++) {
      const input = Array.from({ length: size }, (_, id) => audit(id,
        [' Photo Recognition ', 'photo recognition', 'Manuales', '', 'Otro'][id % 5], 1 + id % 9));
      const result = Distributor.distribute(input, team, { balanceByType: true });
      const stats = Distributor.getValidatorStats(result, team, { balanceByType: true });
      assert.ok(spread(stats.map(val => val.totalAssigned)) <= 1);
      const types = new Set(input.map(item => Distributor.getAuditType(item).key));
      for (const key of types) {
        const counts = team.map(val => result.filter(item => item.assignedValidatorId === val.id && Distributor.getAuditType(item).key === key).length);
        assert.ok(spread(counts) <= 1);
      }
    }
  }
});

test('solo Smart Lindley activa Tipo y la redistribución conserva completadas y en progreso', () => {
  const app = Object.create(ValidaFlowApp.prototype);
  for (const module of ['smart', 'blocking']) {
    for (const study of ['Lindley', 'Chile', 'Tradicional', 'Moderno']) {
      app.currentModule = module;
      app.currentProject = study;
      assert.equal(app.getDistributionOptions().balanceByType, module === 'smart' && study === 'Lindley');
    }
  }
  app.currentModule = 'smart';
  app.currentProject = 'Lindley';
  const completed = { ...audit(100, 'Manuales', 10), assignedValidatorId: 'C', validationStatus: 'completada' };
  const inProgress = { ...audit(101, 'Manuales', 10), assignedValidatorId: 'B', validationStatus: 'en_progreso' };
  app.audits = [completed, inProgress, ...Array.from({ length: 12 }, (_, id) => ({ ...audit(id, id < 6 ? 'Manuales' : 'Photo Recognition', 2), validationStatus: 'pendiente' }))];
  app.getAuditsForCurrentProject = () => app.audits;
  app.getValidatorsForCurrentProject = () => validators;
  app.redistributePendingAudits();
  assert.equal(app.audits[0], completed);
  assert.equal(app.audits[1], inProgress);
  const stats = Distributor.getValidatorStats(app.audits.slice(2), validators, { balanceByType: true });
  for (const val of stats) assert.ok(val.auditTypes.every(type => type.count === 2));
});
