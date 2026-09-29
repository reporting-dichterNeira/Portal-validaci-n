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

test('current-month snapshots auto-publish, only the preceding month can close, and closed months are rejected', () => {
  const receiver = read('supabase/functions/sync-databricks-export/index.ts');
  const publishing = read('supabase/migrations/20260929201144_freeze_monthly_databricks_exports.sql');
  const daily = read('supabase/migrations/20260929203815_auto_publish_current_databricks_month.sql');
  assert.match(receiver, /period !== previous \|\| period < '2026-09'/);
  assert.match(receiver, /MONTH_ALREADY_CLOSED/);
  assert.match(receiver, /status: 'review'/);
  assert.match(receiver, /if \(!publishingRoles\.has\(user\.role\)\)/);
  assert.match(receiver, /adminClient\.rpc\('finish_admin_databricks_sync'/);
  assert.match(receiver, /p_close_month: Boolean\(job\.close_month\)/);
  assert.match(receiver, /published: true/);
  assert.match(publishing, /where id = p_job_id and status = 'review'/);
  assert.match(publishing, /SYNC_MONTH_FROZEN/);
  assert.match(publishing, /SYNC_NOT_PREVIOUS_MONTH/);
  assert.match(daily, /SYNC_ONLY_CURRENT_MONTH/);
  assert.match(daily, /sincronización diaria/);
  const grants = read('supabase/migrations/20260929205712_grant_databricks_publisher_tables.sql');
  assert.match(grants, /grant select, insert, update, delete/);
  assert.match(grants, /on public\.admin_analysis_imports,[\s\S]*public\.admin_alert_export_records[\s\S]*to service_role/);
  assert.match(read('supabase/migrations/20260929172300_databricks_staged_review.sql'), /SYNC_NEWER_STAGE_EXISTS/);
});

test('the scheduled warm-up runs on the Reporting Cluster before export synchronization', () => {
  const warmup = read('databricks/validaflow_reporting_warmup.py');
  assert.match(warmup, /spark\.range\(1\)\.count\(\)/);
});

test('batch uploads retry transient errors and preserve database error details', () => {
  const notebook = read('databricks/validaflow_general_export.py');
  const receiver = read('supabase/functions/sync-databricks-export/index.ts');
  assert.match(notebook, /range\(4 if action == "batch" else 1\)/);
  assert.match(notebook, /response\.status_code in \(429, 500, 502, 503, 504\)/);
  assert.match(notebook, /response\.text\[:500\]/);
  assert.match(receiver, /failure\.code, failure\.message, failure\.details/);
});

test('the portal leaves past general exports read-only while allowing current-month backup', () => {
  const app = read('js/app.js');
  const backend = read('js/supabase-backend.js');
  assert.match(app, /isFixedHistory = datasetType === 'alerts'/);
  assert.match(app, /Histórico fijo/);
  assert.match(app, /periodMonth !== this\.getCurrentBogotaMonth\(\)/);
  assert.match(backend, /if \(normalizedMonth !== currentMonth\)/);
});

test('the portal offers an automatic-publishing status without a review button', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  assert.match(html, /publica automáticamente cada mañana el mes vigente/);
  assert.doesNotMatch(html, /Publicar base revisada/);
  assert.doesNotMatch(html, /Revisar muestra de auditorías antes de publicar/);
  assert.match(app, /auditorías publicadas automáticamente desde Reporting Cluster/);
});

test('the status distinguishes a published current month from fixed history', () => {
  const app = read('js/app.js');
  const start = app.indexOf('  updateAdminDatabricksSyncStatus(job) {');
  const end = app.indexOf('\n  ensureAdminDatabricksMonthStatus(', start);
  assert.ok(start > 0 && end > start);
  const elements = new Map([
    ['admin-alerts-databricks-status', {}],
    ['admin-alerts-export-period', { value: '2026-09' }],
  ]);
  const render = vm.runInNewContext(`({${app.slice(start, end)}}).updateAdminDatabricksSyncStatus`, {
    document: { getElementById: id => elements.get(id) }
  });
  const instance = { formatExternalImportMonth: () => 'septiembre de 2026', getCurrentBogotaMonth: () => '2026-09' };
  render.call(instance, {
    id: 'job', periodMonth: '2026-09-01', status: 'complete', rowsStaged: 42617,
  });
  assert.match(elements.get('admin-alerts-databricks-status').textContent, /42\.617 auditorías publicadas automáticamente/);
  elements.get('admin-alerts-export-period').value = '2026-08';
  render.call(instance, null);
  assert.match(elements.get('admin-alerts-databricks-status').textContent, /Histórico fijo/);
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
  const instance = { checkAdminDatabricksSyncStatus: () => { checks += 1; }, getCurrentBogotaMonth: () => '2026-09' };
  ensure.call(instance);
  ensure.call(instance, '2026-08-01');
  assert.match(input.value, /^20\d{2}-(0[1-9]|1[0-2])$/);
  assert.equal(input.listeners, 1);
  assert.equal(checks, 1);
});
