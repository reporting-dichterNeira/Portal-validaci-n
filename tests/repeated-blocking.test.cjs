const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js'),M=global.PortalIndicatorMetrics;
const original={id:'123',_module:'blocking',estudio:'Lindley',_studyId:'s',_countryId:'pe',
  _batchId:1,_batchOperationDate:'2026-09-01',fechaAuditoriaOriginal:'2026-09-01',validationStatus:'completada',
  kpis:[{name:'A',needsReview:true}],validationResults:{A:{status:'aplica',decisionAt:'2026-09-01T17:00:00Z'}},_validatorName:'Original'};
const pending={...original,_batchId:2,_batchOperationDate:'2026-10-01',validationStatus:'pendiente',validationResults:{},_validatorName:'Nuevo'};

test('same-day replacement does not hide completed evidence; canonical is idempotent and immutable',()=>{
  const rows=[original,{...pending,_batchOperationDate:original._batchOperationDate}],before=JSON.stringify(rows);
  assert.deepEqual(U.canonical(rows),[original]);
  assert.deepEqual(U.canonical(U.canonical(rows)),[original]);
  assert.equal(JSON.stringify(rows),before);
  assert.deepEqual(U.canonical([...rows].reverse()),[original]);
});
test('Blocking completion suppresses only Blocking repeats in the same study and country',()=>{
  const smart={...pending,_module:'smart'},otherStudy={...pending,_studyId:'other'},otherCountry={...pending,_countryId:'cl'};
  const rows=U.canonical([original,pending,smart,otherStudy,otherCountry]);
  assert.equal(rows.length,4);assert.ok(rows.includes(smart));assert.ok(rows.includes(otherStudy));assert.ok(rows.includes(otherCountry));
  const smartOld={...original,_module:'smart'};
  assert.deepEqual(U.canonical([smartOld,smart]),[smart]);
  assert.deepEqual(U.canonical([smartOld,pending]),[smartOld,pending]);
});
test('partial review is not a completed audit and numeric ID formatting does not create another audit',()=>{
  assert.deepEqual(U.canonical([{...original,validationStatus:'en_progreso'},pending]),[pending]);
  assert.deepEqual(U.canonical([original,{...pending,id:'00123'}]),[original]);
});
test('latest actual Blocking completion is preserved rather than copying its decisions to a new payload',()=>{
  const completed={...pending,validationStatus:'completada',validationResults:{A:{status:'no_aplica'}}};
  assert.deepEqual(U.canonical([original,completed,{...pending,_batchId:3}]),[completed]);
});
test('CSV and month filters retain real completion dates, original validator and independent Smart pending',()=>{
  const rows=[original,pending,{...pending,_module:'smart'}];
  const exports=U.alertExport(rows);
  assert.equal(exports.rows.length,2);
  assert.equal(exports.rows[0][13],'Original');
  assert.equal(exports.rows[0][15],'Alertas válidas');
  assert.equal(exports.rows[1][15],'Pendiente');
  const adapted=U.adapt(rows,[],null,'all');
  const result=M.compute(adapted,{asOf:'2026-10-19',from:'2026-10-01',to:'2026-10-19'});
  assert.equal(result.counts.pending,1);
  assert.equal(M.compute(adapted,{asOf:'2026-10-19',from:'2026-10-01',to:'2026-10-19',module:'blocking'}).alerts.filter(a=>a.module==='blocking').length,0);
});
