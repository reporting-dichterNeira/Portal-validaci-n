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
 const receipts=[...rows,{id:'10',_module:'smart',estudio:'Chile',fecha:'2026-10-01',kpis:[]},{id:'11',_module:'smart',estudio:'Chile',fecha:'2026-10-01',kpis:[]},{id:'11',_module:'smart',estudio:'Chile',fecha:'2026-10-01',kpis:[]},{id:'12',_module:'smart',estudio:'Chile',fecha:'2026-09-01',kpis:[]}];
 try {U.render(app,rows,null,null,receipts);await new Promise(resolve=>setImmediate(resolve));U.render(app,rows,null,null,receipts);U.render(app,rows,null,null,receipts);
 assert.equal(calls,1);assert.equal(filters.month,'2026-10');assert.deepEqual(filters.studies,['Chile']);
 assert.match(target.innerHTML,/2\.702/);assert.match(target.innerHTML,/Auditorías recibidas · Bloqueantes/);assert.match(target.innerHTML,/Recibidas · Smart/);assert.doesNotMatch(target.innerHTML,/Chile aún no|Histórico Excel|histórico Excel|Total Databricks/);
 assert.match(target.innerHTML,/<td>Chile<\/td><td>2\.702<\/td><td>1<\/td><td>2<\/td>/);
 }finally{delete global.document;}
});
test('un fallo de acceso no se presenta como ausencia de datos y se puede reintentar',async()=>{
 let calls=0,retry;const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:s=>s==='[data-universe-refresh]'?{addEventListener:(_event,fn)=>retry=fn}:null};target.parentElement.children=[target];global.document={getElementById:()=>target};
 const rows=[{id:'10',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[{name:'A',needsReview:true}]}];
 const app={currentProfile:{id:'supervisor'},currentView:'visualizations',reportsSubtab:'operational',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',backend:{async loadDatabricksAuditTotals(){calls++;if(calls===1)throw new Error('VISUALIZATION_ACCESS_REQUIRED');return {studies:[{study_name:'Chile',databricks_total:2702}],snapshots:[{month:'2026-10-01',source:'Databricks · Reporting Cluster'}]};}},renderReportsView(){U.render(app,rows);}};
 try {app.renderReportsView();await new Promise(resolve=>setImmediate(resolve));assert.match(target.innerHTML,/Error al consultar/);assert.doesNotMatch(target.innerHTML,/Sin datos|Histórico Excel/);retry();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.match(target.innerHTML,/2\.702/);assert.doesNotMatch(target.innerHTML,/VISUALIZATION_ACCESS_REQUIRED/);}finally{delete global.document;}
});
