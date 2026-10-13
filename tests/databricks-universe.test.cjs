const {test}=require('node:test');const assert=require('node:assert/strict');
const M=require('../js/indicator-metrics.js');global.PortalIndicatorMetrics=M;
const U=require('../js/indicator-dashboard.js');
test('Chile ko_trad_ch nunca aumenta el universo de KO Tradicional CAM',()=>{
 const audits=M.normalizeAudits([{id:'1',study:'ko_trad_ch_202610',periodDate:'2026-10-01',kpis:[]},{id:'2',study:'ko_trad_cr_202610',periodDate:'2026-10-01',kpis:[]}]);
 assert.equal(audits[0].study,'Chile');assert.equal(audits[1].study,'KO Tradicional CAM');
 const counts=M.compute(audits,{asOf:'2026-10-12'}).auditCountsByStudy;
 assert.deepEqual(counts,{Chile:1,'KO Tradicional CAM':1});
});
test('universo usa una consulta agregada reutilizable y mantiene independientes los casos del portal',async()=>{
 let calls=0,filters;const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:()=>null};target.parentElement.children=[target];
 global.document={getElementById:()=>target};
 const app={currentProfile:{id:'test'},currentView:'visualizations',reportsSubtab:'executive',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',selectedStudies:['Chile'],selectedReportCountry:'all',indicatorExecutiveSection:'summary',renderReportsView(){},backend:{async loadDatabricksAuditTotals(f){calls++;filters=f;return {studies:[{study_name:'Chile',databricks_total:2702,export_total:2702,verified:true}],snapshots:[{month:'2026-10-01',source:'Databricks · Reporting Cluster',refreshed_at:'2026-10-12'}]};}}};
 const rows=[{id:'10',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[{name:'A',needsReview:true}]}];
 try {U.render(app,rows);await new Promise(resolve=>setImmediate(resolve));U.render(app,rows);U.render(app,rows);
 assert.equal(calls,1);assert.equal(filters.month,'2026-10');assert.deepEqual(filters.studies,['Chile']);
 assert.match(target.innerHTML,/2\.702/);assert.match(target.innerHTML,/Auditorías recibidas · sistema/);assert.doesNotMatch(target.innerHTML,/Chile aún no/);
 }finally{delete global.document;}
});
