global.PortalStudyLabels=require('./study-labels-fixture.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const M=require('../js/indicator-metrics.js');global.PortalIndicatorMetrics=M;
const U=require('../js/indicator-dashboard.js');

test('porcentajes de recibidas usan total levantado por estudio y en el consolidado',()=>{
 const scope={entry:{loading:false,error:''},total:100,partial:false,verified:true,names:['Chile'],rows:[{study_name:'Chile',databricks_total:100}],snapshots:[{month:'2026-10',source:'Databricks'}]};
 const blocking={audits:10,auditCountsByStudy:{Chile:10}},smart={audits:5,auditCountsByStudy:{Chile:5}};
 const app={};
 const html=U.universePanel(scope,blocking,smart,app);
 assert.match(html,/Total levantado/);assert.match(html,/Auditorías recibidas en Bloqueantes/);assert.match(html,/Auditorías recibidas en Smart/);
 assert.match(html,/10% del total levantado/);assert.match(html,/5% del total levantado/);
 assert.match(html,/<td>KO Tradicional CHILE<\/td><td>100<\/td><td>10<\/td><td>5<\/td><td>10%<\/td><td>5%<\/td>/);
 assert.equal(U.receiptShare(0,100),0);assert.equal(U.receiptShare(10,100),.1);assert.equal(U.receiptShare(110,100),1.1);
 for(const base of [0,null,undefined,NaN])assert.equal(U.receiptShare(10,base),null);
 assert.doesNotMatch(U.universePanel({...scope,total:0,rows:[{study_name:'Chile',databricks_total:0}]},blocking,smart,app),/NaN|Infinity|10% del total/);
 const loading=U.universePanel(scope,blocking,smart,{backend:{configured:true},auditHistoryByModule:{blocking:[],smart:null}});
 assert.match(loading,/Consultando…/);assert.doesNotMatch(loading,/5% del total levantado/);
});
test('Chile ko_trad_ch nunca aumenta el universo de KO Tradicional CAM',()=>{
 const audits=M.normalizeAudits([{id:'1',study:'ko_trad_ch_202610',periodDate:'2026-10-01',kpis:[]},{id:'2',study:'ko_trad_cr_202610',periodDate:'2026-10-01',kpis:[]}]);
 assert.equal(audits[0].study,'Chile');assert.equal(audits[1].study,'KO Tradicional CAM');
 const counts=M.compute(audits,{asOf:'2026-10-12'}).auditCountsByStudy;
 assert.deepEqual(counts,{Chile:1,'KO Tradicional CAM':1});
});
test('universo usa una consulta agregada reutilizable y mantiene independientes los casos del portal',async()=>{
 let calls=0,filters;const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:()=>null};target.parentElement.children=[target];
 global.document={getElementById:()=>target};
 const app={currentProfile:{id:'test'},currentView:'visualizations',selectedMetricsMonth:'2026-10',reportsSubtab:'metrics',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',selectedStudies:['Chile'],selectedReportCountry:'all',indicatorExecutiveSection:'summary',renderReportsView(){},backend:{async loadDatabricksAuditTotals(f){calls++;filters=f;return {studies:[{study_name:'Chile',databricks_total:2702,export_total:2702,verified:true}],snapshots:[{month:'2026-10-01',source:'Databricks · Reporting Cluster',refreshed_at:'2026-10-12'}]};}}};
 const rows=[{id:'10',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[{name:'A',needsReview:true}]}];
 const receipts=[...rows,{id:'10',_module:'smart',estudio:'Chile',fecha:'2026-10-01',kpis:[]},{id:'11',_module:'smart',estudio:'Chile',fecha:'2026-10-01',kpis:[]},{id:'11',_module:'smart',estudio:'Chile',fecha:'2026-10-01',kpis:[]},{id:'12',_module:'smart',estudio:'Chile',fecha:'2026-09-01',kpis:[]}];
 try {U.render(app,rows,null,null,receipts);await new Promise(resolve=>setImmediate(resolve));U.render(app,rows,null,null,receipts);U.render(app,rows,null,null,receipts);
 assert.equal(calls,1);assert.equal(filters.month,'2026-10');assert.deepEqual(filters.studies,['Chile']);
 assert.match(target.innerHTML,/2\.702/);assert.match(target.innerHTML,/Auditorías recibidas en Bloqueantes/);assert.match(target.innerHTML,/Auditorías recibidas en Smart/);assert.doesNotMatch(target.innerHTML,/Chile aún no|Histórico Excel|histórico Excel|Total Databricks/);
 assert.match(target.innerHTML,/<td>KO Tradicional CHILE<\/td><td>2\.702<\/td><td>1<\/td><td>2<\/td>/);
 }finally{delete global.document;}
});
test('un fallo de acceso no se presenta como ausencia de datos y se puede reintentar',async()=>{
 let calls=0,retry;const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:s=>s==='[data-universe-refresh]'?{addEventListener:(_event,fn)=>retry=fn}:null};target.parentElement.children=[target];global.document={getElementById:()=>target};
 const rows=[{id:'10',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[{name:'A',needsReview:true}]}];
 const app={currentProfile:{id:'supervisor'},currentView:'visualizations',reportsSubtab:'operational',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',backend:{async loadDatabricksAuditTotals(){calls++;if(calls===1)throw new Error('VISUALIZATION_ACCESS_REQUIRED');return {studies:[{study_name:'Chile',databricks_total:2702}],snapshots:[{month:'2026-10-01',source:'Databricks · Reporting Cluster'}]};}},renderReportsView(){U.render(app,rows);}};
 try {app.renderReportsView();await new Promise(resolve=>setImmediate(resolve));assert.match(target.innerHTML,/Error al consultar/);assert.doesNotMatch(target.innerHTML,/Sin datos|Histórico Excel/);retry();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.match(target.innerHTML,/2\.702/);assert.doesNotMatch(target.innerHTML,/VISUALIZATION_ACCESS_REQUIRED/);}finally{delete global.document;}
});

test('espera la restauración de sesión y separa la caché entre usuarios sin id de perfil',async()=>{
 let calls=0;
 const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:()=>null};target.parentElement.children=[target];
 global.document={getElementById:()=>target};
 const rows=[{id:'10',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[]}];
 const app={currentProfile:null,currentRole:null,currentView:'visualizations',reportsSubtab:'metrics',getVisualizationModuleFilter:()=> 'all',getReportCountry:()=> 'Chile',
  backend:{configured:true,async loadDatabricksAuditTotals(){calls++;return {studies:[{study_name:'Chile',databricks_total:100}],snapshots:[{month:'2026-10-01',source:'Databricks'}]};}},renderReportsView(){U.render(app,rows);}};
 try {
  app.renderReportsView();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);assert.equal(app.databricksTotalsCache.size,0);assert.doesNotMatch(target.innerHTML,/Error al consultar/);
  app.currentRole='visualizer';app.currentProfile={username:'primero'};app.currentView='visualizations';
  app.renderReportsView();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.match(target.innerHTML,/Total levantado/);assert.doesNotMatch(target.innerHTML,/Error al consultar/);
  app.renderReportsView();assert.equal(calls,1);
  app.currentProfile={username:'segundo'};app.renderReportsView();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  app.currentRole='validator';app.renderReportsView();assert.equal(calls,2);
 }finally{delete global.document;}
});

test('Smart pendiente de consulta o con error no muestra cero y Actualizar vuelve a consultar ambos históricos',async()=>{
 let refresh;
 const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:s=>s==='[data-universe-refresh]'?{addEventListener:(_event,fn)=>refresh=fn}:null};
 target.parentElement.children=[target];global.document={getElementById:()=>target};
 const blocking={id:'10',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[]};
 const smart={id:'10',_module:'smart',estudio:'Chile',fecha:'2026-10-01',validationStatus:'completada',kpis:[{name:'Precio',needsReview:true}],validationResults:{Precio:{status:'aplica'}}};
 const app={currentView:'visualizations',reportsSubtab:'operational',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',
   selectedStudies:['Chile'],backend:{configured:true},auditHistoryByModule:{blocking:[blocking],smart:null},
   renderReportsView(){U.render(app,[blocking],null,null,[blocking,...(app.auditHistoryByModule.smart||[])]);},
   async ensureIndicatorHistoriesLoaded(opts){assert.equal(opts.force,true);app.auditHistoryErrors={};app.auditHistoryByModule.smart=[smart];}
 };
 try {
   app.renderReportsView();assert.match(target.innerHTML,/<td>KO Tradicional CHILE<\/td><td>[^<]*<\/td><td>1<\/td><td>Consultando…<\/td>/);
   app.auditHistoryErrors={smart:'Access denied'};app.renderReportsView();
   assert.match(target.innerHTML,/<td>KO Tradicional CHILE<\/td><td>[^<]*<\/td><td>1<\/td><td>Error al consultar<\/td>/);
   await refresh();assert.match(target.innerHTML,/<td>KO Tradicional CHILE<\/td><td>[^<]*<\/td><td>1<\/td><td>1<\/td>/);
   app.currentScope={module:'blocking'};app.renderReportsView();assert.match(target.innerHTML,/<td>Fuera de alcance<\/td>/);
 }finally{delete global.document;}
});

test('el país seleccionado se envía a Export sin convertir Chile o Perú en una región',async()=>{
 let filters;
 const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:()=>null};target.parentElement.children=[target];
 global.document={getElementById:()=>target};
 const app={currentView:'visualizations',reportsSubtab:'operational',selectedStudies:['Chile'],selectedMetricsCountry:'Chile',selectedReportCountry:'all',
  getVisualizationModuleFilter:()=> 'all',getReportCountry:()=> 'Chile',renderReportsView(){},
  getMetricsScopeOptions:()=>({studies:[{value:'Chile',label:'Chile'}],countries:[{value:'Chile',label:'Chile'}]}),
  backend:{async loadDatabricksAuditTotals(f){filters=f;return {studies:[],snapshots:[]};}}};
 try {
  U.render(app,[{id:'1',_module:'blocking',estudio:'Chile',fecha:'2026-10-01',kpis:[]}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(filters.country,'Chile');assert.equal(filters.geography,'all');assert.deepEqual(filters.studies,['Chile']);
  assert.match(target.innerHTML,/data-metric-scope-filter="country"/);assert.match(target.innerHTML,/value="Chile" selected/);
 }finally{delete global.document;}
});
