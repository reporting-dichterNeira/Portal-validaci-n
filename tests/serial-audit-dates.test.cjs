const {test}=require('node:test'),assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const M=global.PortalIndicatorMetrics,U=require('../js/indicator-dashboard.js'),R=require('../js/indicator-report.js');
const rows=[46309.68775747685,'46309.49905092592','46310.66191362269','46308.92108799768'].map((date,i)=>({
 id:String(i+1),estudio:'Moderno',pais:'Panamá',_module:'blocking',fecha:'2026-10-17',fechaAuditoriaOriginal:date,
 _batchUploadedAt:'2026-10-17T12:00:00Z',validationStatus:'completada',
 kpis:[{name:'A',needsReview:true}],validationResults:{A:{status:'aplica',decisionAt:'2026-10-17T13:00:00Z'}}
}));
test('actual Excel serial values recover the original calendar day without inventing a timezone',()=>{
 assert.deepEqual(rows.map(a=>M.dateKey(a.fechaAuditoriaOriginal)),['2026-10-14','2026-10-14','2026-10-15','2026-10-13']);
 for(const value of ['46309',46309.999999,'46309,68775747685'])assert.deepEqual(M.eventStamp(value),{day:'2026-10-14',ms:null});
 assert.equal(M.dateKey('2026-10-14'),'2026-10-14');
 assert.equal(M.dateKey('14/10/2026'),'2026-10-14');
 for(const value of ['',null,'2026','20261014','0','999999','NaN','2026-02-30'])assert.equal(M.eventStamp(value),null);
});
test('monthly intake timings now have audit samples; decisions retain their independent exact hours',()=>{
 const before=JSON.stringify(rows),r=M.compute(U.adapt(rows),{asOf:'2026-10-19'});
 assert.equal(r.timing.intake.measured,4);assert.equal(r.timing.intake.meanDays,3);
 assert.equal(r.timing.intake.meanHours,null);assert.equal(r.timing.intake.dateOnly,4);
 assert.equal(r.timing.monthly[0].intake.measured,4);assert.equal(r.timing.monthly[0].intake.meanDays,3);
 assert.equal(r.timing.validation.meanHours,1);assert.equal(r.timing.validation.measured,4);
 assert.equal(JSON.stringify(rows),before);
});
test('genuinely missing, reversed and future dates still cannot manufacture valid intake samples',()=>{
 const inputs=U.adapt([
 {...rows[0],id:'10',fechaAuditoriaOriginal:''},
 {...rows[0],id:'11',fechaAuditoriaOriginal:46310,_batchUploadedAt:'2026-10-14T12:00:00Z'},
 {...rows[0],id:'12',fechaAuditoriaOriginal:46315}
 ]);
 const t=M.compute(inputs,{asOf:'2026-10-19'}).timing.intake;
 assert.equal(t.measured,0);assert.equal(t.missing,1);assert.equal(t.invalid,1);assert.equal(t.future,1);
});
test('dated pending serials stay eligible while truly undated pending alerts remain excluded; CSV and PDF agree',()=>{
 const pending={...rows[0],id:'20',validationStatus:'pendiente',validationResults:{}};
 const data=[...rows,pending,{...pending,id:'21',fechaAuditoriaOriginal:''}];
 const exported=U.alertExport(data);
 assert.equal(exported.counts.pending,1);assert.equal(exported.rows.length,5);
 assert.deepEqual(exported.rows.map(r=>r[4]),['2026-10-14','2026-10-14','2026-10-15','2026-10-13','2026-10-14']);
 const app={currentView:'visualizations',selectedStudies:['ALL'],selectedMetricsMonth:'2026-10',indicatorFilters:{},
 getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais,getReportAuditSource:()=>data,getFilteredAuditsForReports:()=>data};
 const snapshot=R.buildSnapshot(app);
 assert.equal(snapshot.result.counts.pending,1);assert.equal(snapshot.result.timing.intake.measured,5);
 assert.equal(snapshot.result.timing.intake.meanDays,3);
});
