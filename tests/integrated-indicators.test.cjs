const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const M=global.PortalIndicatorMetrics;
const sample=(id,decisions,extra={})=>({id:String(id),study:'Moderno',country:'Panamá',periodDate:'2026-10-08',auditDate:'2026-10-08',auditor:'campo.a',kpis:decisions.map((decision,i)=>({name:'K'+i,needsReview:true,decision})),...extra});
const compute=(rows,filters={})=>M.compute(M.normalizeAudits(rows),{from:'2026-08-01',to:'2026-10-08',asOf:'2026-10-08',...filters});
test('23 definitions stay explicit: 13 available and 10 not calculated',()=>{
 const catalog=require('../js/indicator-catalog.js');
 assert.equal(catalog.length,23);assert.equal(new Set(catalog.map(c=>c.id)).size,23);
 assert.equal(catalog.filter(c=>c.formula).length,13);assert.equal(catalog.filter(c=>c.reason).length,10);
});
test('coverage and rejection use all alerts, not just decisions',()=>{
 const row=sample(1,['aplica','no_aplica','pendiente','pendiente']);row.kpis.push({name:'Not alerted',needsReview:false});
 const r=compute([row]);assert.equal(r.counts.total,4);assert.equal(r.counts.coverage,.5);
 assert.equal(r.counts.rejection,.25);assert.equal(r.counts.application,.25);
 assert.equal(compute([]).counts.rejection,null);
});
test('backlog boundaries count audits once and keep missing/future dates separate',()=>{
 const r=compute(['2026-10-02','2026-10-01','2026-09-24','2026-09-23',null,'2026-10-09'].map((auditDate,i)=>sample(i+1,['pendiente','pendiente'],{auditDate})));
 assert.equal(r.backlog.recent.length,1);assert.equal(r.backlog.week.length,2);assert.equal(r.backlog.old.length,1);
 assert.equal(r.backlog.missing.length,1);assert.equal(r.backlog.future.length,1);assert.equal(r.counts.pending,12);
});
test('monthly comparison only uses consecutive complete months',()=>{
 const r=compute([sample(1,['aplica'],{periodDate:'2026-08-02'}),sample(2,['aplica','pendiente'],{periodDate:'2026-09-02'}),sample(3,['pendiente'],{periodDate:'2026-10-02'})]);
 assert.equal(r.monthly[1].change,1);assert.equal(r.monthly[2].change,null);assert.equal(r.monthly[2].partial,true);
});
test('two timing legs exclude missing, negative and future events without manufacturing hours',()=>{
 const row=sample(1,['aplica','no_aplica','pendiente'],{auditDate:'2026-10-01',alertUploadedAt:'2026-10-03T12:00:00Z'});
 row.kpis[0].validatedAt='2026-10-03T18:00:00Z';row.kpis[1].validatedAt='2026-10-05';
 const r=compute([row]);assert.equal(r.timing.intake.meanDays,2);assert.equal(r.timing.intake.meanHours,null);
 assert.equal(r.timing.validation.measured,2);assert.equal(r.timing.validation.meanHours,6);assert.equal(r.timing.validation.dateOnly,1);
 assert.equal(M.interval(M.eventStamp('2026-10-04'),M.eventStamp('2026-10-03'),'2026-10-08').state,'invalid');
 assert.equal(M.interval(M.eventStamp('2026-10-04'),M.eventStamp('2026-10-09'),'2026-10-08').state,'future');
});
const base={id:'123',_module:'blocking',estudio:'Moderno',_studyId:'s',_countryId:'c',_batchId:1,_batchOperationDate:'2026-10-01',
 meta:{FECHA_AU:'2026-09-30',region:'Norte',subcanal:'Supermercado'},_createdAt:'2026-10-01T12:00:00Z',pais:'Panamá',
 kpis:[{name:'A',needsReview:true}],validationResults:{A:{status:'no_aplica',tipificacion:'Falso positivo',decisionAt:'2026-10-02T12:00:00Z'}}};
test('adapter keeps original audit, upload and decision timestamps, daily dimensions have priority',()=>{
 const [a]=U.adapt([base],[{audit_external_id:'123',region:'Sur',subchannel:'Otro',audit_date:'2026-09-29'}]);
 assert.equal(a.auditDate,'2026-09-30');assert.equal(a.region,'Norte');assert.equal(a.subchannel,'Supermercado');
 const r=global.PortalIndicatorMetrics.compute([a],{asOf:'2026-10-10',from:'2026-10-01',to:'2026-10-10'});
 assert.equal(r.counts.rejects,1);assert.equal(r.timing.intake.dateOnly,1);assert.equal(r.timing.validation.meanHours,24);
});
test('retired and superseded rows never inflate metrics; repeated accepted IDs count once',()=>{
 const rows=U.canonical([base,{...base,_batchId:2},{...base,id:'124',_pendingResolution:'removed'}]);
 assert.equal(rows.length,1);assert.equal(rows[0]._batchId,2);
 assert.equal(U.canonical([base,{...base,id:'124',_module:'smart'}]).length,2);
});
test('missing original date stays missing; no operation date or completion fallback',()=>{
 const [a]=U.adapt([{...base,meta:{},validationResults:{A:{status:'aplica'}},completedAt:'2026-10-02T12:00:00Z'}]);
 assert.equal(a.auditDate,null);assert.equal(a.kpis[0].validatedEvent,null);
});
test('context conflicts remain missing rather than selecting first row',()=>{
 const [a]=U.adapt([{...base,meta:{}}],[{audit_external_id:'123',region:'Norte'},{audit_external_id:'123',region:'Sur'}]);
 assert.equal(a.region,'');
});
test('single CSV escapes formula injection and preserves numeric values',()=>{
 assert.match(U.csv(['Dato'],[['=1+1'],[0]]),/"'=1\+1"/);assert.match(U.csv(['Dato'],[[0]]),/"0"/);
});
test('reassignment keeps original history while canonicalizing the physical upload day',()=>{
 const original={...base,id:'124',validationStatus:'completada'};
 const moved={...base,_batchId:2,_originalOperationDate:'2026-10-01',_physicalBatchOperationDate:'2026-10-02'};
 const current={...moved,id:'125',_batchOperationDate:'2026-10-02'};
 assert.equal(U.canonical([original,moved,current]).length,3);
 assert.equal(U.adapt([moved])[0].periodDate,'2026-10-01');
});
test('a newer corrected payload needs review even if an older version was completed',()=>{
 const old={...base,validationStatus:'completada'};
 const fresh={...base,_batchId:2,_batchOperationDate:'2026-10-02',validationStatus:'pendiente',validationResults:{}};
 const [chosen]=U.canonical([old,fresh]);
 assert.equal(chosen._batchId,2);assert.equal(chosen.validationStatus,'pendiente');
});
