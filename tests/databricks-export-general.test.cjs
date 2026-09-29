const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Databricks only queries the current month and an unfinished prior-month close', () => {
  const notebook = read('databricks/validaflow_general_export.py');
  assert.match(notebook, /FROM storeview\.slv_sv_ceres_ag_export/);
  assert.match(notebook, /lower\(Survey\) LIKE '%ko_trad%'/);
  assert.match(notebook, /lower\(Survey\) LIKE '%ko_moderno%'/);
  assert.match(notebook, /lower\(Survey\) LIKE '%lindley%'/);
  assert.match(notebook, /"action": "schedule"/);
  assert.match(notebook, /month_to_close = schedule\.get\("monthToClose"\)/);
  assert.match(notebook, /periods = \[\(month_to_close, True\)\] if month_to_close else \[\]/);
  assert.match(notebook, /periods\.append\(\(current_month, False\)\)/);
  assert.match(notebook, /"complete", expectedCount=sent_count/);
  assert.doesNotMatch(notebook, /["']approve["']/);
});

test('only the preceding month can be closed automatically, and closed months are rejected', () => {
  const receiver = read('supabase/functions/sync-databricks-export/index.ts');
  const publishing = read('supabase/migrations/20260929201144_freeze_monthly_databricks_exports.sql');
  assert.match(receiver, /period !== previous \|\| period < '2026-09'/);
  assert.match(receiver, /MONTH_ALREADY_CLOSED/);
  assert.match(receiver, /status: 'review'/);
  assert.match(receiver, /if \(!publishingRoles\.has\(user\.role\)\)/);
  assert.match(receiver, /adminClient\.rpc\('finish_admin_databricks_sync'/);
  assert.match(receiver, /p_close_month: true/);
  assert.match(publishing, /where id = p_job_id and status = 'review'/);
  assert.match(publishing, /SYNC_MONTH_FROZEN/);
  assert.match(publishing, /SYNC_NOT_PREVIOUS_MONTH/);
  assert.match(read('supabase/migrations/20260929172300_databricks_staged_review.sql'), /SYNC_NEWER_STAGE_EXISTS/);
});

test('the scheduled warm-up runs on the Reporting Cluster before export synchronization', () => {
  const warmup = read('databricks/validaflow_reporting_warmup.py');
  assert.match(warmup, /spark\.range\(1\)\.count\(\)/);
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
  const end = app.indexOf('\n  ensureAdminDatabricksMonthStatus(', start);
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

test('opening Export general checks the current month before large visual data loads', () => {
  const app = read('js/app.js');
  const start = app.indexOf('  ensureAdminDatabricksMonthStatus(preferredMonth = null) {');
  const end = app.indexOf('\n  async checkAdminDatabricksSyncStatus()', start);
  assert.ok(start > 0 && end > start);
  const input = { value: '', dataset: {}, addEventListener() { this.listeners = (this.listeners || 0) + 1; } };
  const ensure = vm.runInNewContext(`({${app.slice(start, end)}}).ensureAdminDatabricksMonthStatus`, {
    document: { getElementById: () => input }, Intl, Date
  });
  let checks = 0;
  const instance = { checkAdminDatabricksSyncStatus: () => { checks += 1; } };
  ensure.call(instance);
  ensure.call(instance, '2026-08-01');
  assert.match(input.value, /^20\d{2}-(0[1-9]|1[0-2])$/);
  assert.equal(input.listeners, 1);
  assert.equal(checks, 1);
});
