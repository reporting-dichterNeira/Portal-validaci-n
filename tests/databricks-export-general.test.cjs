const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Databricks only stages fixed monthly exports for supervisor review', () => {
  const notebook = read('databricks/validaflow_general_export.py');
  assert.match(notebook, /FROM storeview\.slv_sv_ceres_ag_export/);
  assert.match(notebook, /lower\(Survey\) LIKE '%ko_trad%'/);
  assert.match(notebook, /lower\(Survey\) LIKE '%ko_moderno%'/);
  assert.match(notebook, /lower\(Survey\) LIKE '%lindley%'/);
  assert.match(notebook, /period_override not in \(previous_period, current_month\)/);
  assert.match(notebook, /"complete", expectedCount=sent_count/);
  assert.doesNotMatch(notebook, /["']approve["']/);
});

test('the Edge receiver cannot publish with the Databricks staging token', () => {
  const receiver = read('supabase/functions/sync-databricks-export/index.ts');
  const publishing = read('supabase/migrations/20260929172300_databricks_staged_review.sql');
  assert.match(receiver, /allowedScheduledPeriods\(\)\.has\(period\)/);
  assert.match(receiver, /status: 'review'/);
  assert.match(receiver, /if \(!publishingRoles\.has\(user\.role\)\)/);
  assert.match(receiver, /adminClient\.rpc\('finish_admin_databricks_sync'/);
  assert.match(publishing, /v_job\.status <> 'review'/);
  assert.match(publishing, /SYNC_NEWER_STAGE_EXISTS/);
});

test('the portal offers a distinct review and publish step', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  assert.match(html, /Publicar base revisada/);
  assert.match(html, /Revisar muestra de auditorías antes de publicar/);
  assert.match(app, /job\?\.status === 'review'/);
  assert.match(app, /requestDatabricksGeneralExportSync\('approve'/);
});

test('the pending review renders its preview without executable HTML', () => {
  const app = read('js/app.js');
  const start = app.indexOf('  updateAdminDatabricksSyncStatus(job) {');
  const end = app.indexOf('\n  async checkAdminDatabricksSyncStatus()', start);
  assert.ok(start > 0 && end > start);
  const elements = new Map([
    'admin-alerts-databricks-status', 'admin-alerts-databricks-approve-button',
    'admin-alerts-databricks-preview', 'admin-alerts-databricks-preview-rows'
  ].map(id => [id, {}]));
  const render = vm.runInNewContext(`({${app.slice(start, end)}}).updateAdminDatabricksSyncStatus`, {
    document: { getElementById: id => elements.get(id) }
  });
  const instance = { currentRole: 'supervisor', formatExternalImportMonth: () => 'septiembre de 2026' };
  render.call(instance, {
    id: 'job', periodMonth: '2026-09-01', status: 'review', rowsStaged: 1,
    preview: [{ audit_external_id: '123', record: { pdv_id: '<script>alert(1)</script>', study: 'KO' } }]
  });
  assert.equal(elements.get('admin-alerts-databricks-approve-button').disabled, false);
  assert.equal(elements.get('admin-alerts-databricks-preview').hidden, false);
  assert.match(elements.get('admin-alerts-databricks-preview-rows').innerHTML, /&lt;script&gt;/);
  assert.match(elements.get('admin-alerts-databricks-status').textContent, /listas para revisión/);
});
