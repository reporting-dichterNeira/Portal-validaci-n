const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const M=global.PortalIndicatorMetrics,U=require('../js/indicator-dashboard.js'),R=require('../js/indicator-report.js');
const audit=(id,decisions,date,extra={})=>({id:String(id),_module:'blocking',_batchId:1,estudio:'Moderno',pais:'Panamá',
  fecha:'2026-10-10',fechaAuditoriaOriginal:date,_validatorName:'Validador '+id,
  kpis:decisions.map((status,i)=>({name:'K'+i,needsReview:true})),
  validationResults:Object.fromEntries(decisions.map((status,i)=>['K'+i,{status,observaciones:'Detalle '+id}])),...extra});
const rows=[audit(1,['pendiente'],''),audit(2,['aplica','pendiente'],'fecha inválida'),
  audit(3,['no_aplica'],null),audit(4,['pendiente'],'2026-10-01'),
  audit(5,['pendiente'],'2026-02-30',{_module:'smart'}),audit(6,['pendiente'],'2026-10-02',{_module:'smart'})];
const filters={asOf:'2026-10-15',from:'2026-10-01',to:'2026-10-15'};

test('all metrics exclude only undated pending alerts, keep decisions, and never mutate operational data',()=>{
  const before=JSON.stringify(rows),inputs=U.adapt(rows,[],null,'all'),r=M.compute(inputs,filters);
  assert.equal(r.counts.total,4);assert.equal(r.counts.pending,2);assert.equal(r.counts.applies,1);assert.equal(r.counts.rejects,1);
  assert.equal(r.counts.coverage,.5);assert.equal(r.audits,4);
  assert.deepEqual(r.alerts.map(a=>[a.id,a.decision]),[['2','aplica'],['3','no_aplica'],['4','pendiente'],['6','pendiente']]);
  assert.equal(r.backlog.missing.length,0);assert.equal(Object.values(r.backlog).flat().length,2);
  for(const groups of [r.monthly,r.benchmark,r.workload,r.performance,r.rejectedTypes])assert.equal(groups.reduce((n,g)=>n+g.total,0),4);
  assert.equal(M.compute(U.adapt(rows,[],null,'blocking'),filters).counts.pending,1);
  assert.equal(M.compute(U.adapt(rows,[],null,'smart'),filters).counts.pending,1);
  assert.equal(JSON.stringify(rows),before);assert.equal(inputs[1].kpis.length,2);
});

test('historical CSV and summary share the policy and retain correct row metadata after exclusions',()=>{
  const data=U.alertExport(rows),summary=U.alertExport(rows,[],null,'all',{includeRows:false});
  assert.deepEqual(data.counts,summary.counts);assert.equal(data.counts.total,4);assert.equal(data.audits,4);
  assert.deepEqual(data.rows.map(r=>r[1]),['2','3','4','6']);
  for(const row of data.rows){assert.equal(row[13],'Validador '+row[1]);assert.equal(row[17],'Detalle '+row[1]);}
  assert.equal(data.rows.filter(r=>r[15]==='Pendiente').length,2);
  assert.ok(data.rows.filter(r=>r[15]==='Pendiente').every(r=>M.dateKey(r[4])));
});

test('verified original dates from context restore pending alerts; upload/jornada timestamps do not',()=>{
  const context=[{audit_external_id:'1',audit_date:'2026-10-03'}];
  assert.equal(M.compute(U.adapt([rows[0]],context),filters).counts.pending,1);
  assert.equal(U.alertExport([rows[0]],context).counts.pending,1);
  assert.equal(M.compute(U.adapt([{...rows[0],_batchUploadedAt:'2026-10-10T12:00:00Z'}]),filters).counts.pending,0);
});

test('PDF, inherited backlog, and all six views use the same filtered alert population',()=>{
  const app={currentView:'visualizations',reportsSubtab:'metrics',selectedMetricsMonth:'all',selectedStudies:['ALL'],
    getVisualizationModuleFilter:()=> 'all',getReportCountry:a=>a.pais,getReportAuditSource:()=>rows,getFilteredAuditsForReports:()=>rows,
    visualizationDateFrom:filters.from,visualizationDateTo:filters.to,indicatorFilters:{region:'all',channel:'all',subchannel:'all'}};
  const snapshot=R.buildSnapshot(app);assert.equal(snapshot.result.counts.total,4);assert.equal(snapshot.result.counts.pending,2);
  const inherited=U.committeeData(snapshot.result,snapshot.result,U.adapt(rows,[],null,'all'),'2026-11',filters).inherited;
  assert.equal(inherited.counts.pending,2);assert.equal(inherited.backlog.missing.length,0);
  const target={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,parentElement:{children:[]}};
  global.document={getElementById:()=>target};
  try {for(const [section] of U.journey){app.indicatorOperationalSection=section;U.render(app,rows);assert.doesNotMatch(target.innerHTML,/Sin fecha original|sin fecha original para medir|data-indicator-bucket="missing"/);}}
  finally{delete global.document;}
});
