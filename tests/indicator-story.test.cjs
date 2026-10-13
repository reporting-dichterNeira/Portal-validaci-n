const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const M=global.PortalIndicatorMetrics;
const source=(id,date,status)=>({id:String(id),_batchId:1,_module:'blocking',estudio:'Moderno',pais:'Panamá',fecha:date,fechaAuditoriaOriginal:date,kpis:[{name:'K',needsReview:true}],validationResults:status?{K:{status}}:{}});
const rows=[source(1,'2026-08-01','aplica'),source(2,'2026-09-01','no_aplica'),source(3,'2026-09-01',null)];
function render(section='summary',executive=false,module='blocking'){
 const hidden=new Set();
 const legacy={classList:{toggle:(k,on)=>on?hidden.add(k):hidden.delete(k),remove:k=>hidden.delete(k)}};
 const target={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
 target.parentElement={children:[target,legacy]};
 global.document={getElementById:()=>target};
 const app={currentView:'visualizations',reportsSubtab:executive?'executive':'operational',getVisualizationModuleFilter:()=>module,getReportCountry:a=>a.pais,indicatorOperationalSection:section,indicatorExecutiveSection:section,visualizationDateFrom:'2026-08-01',visualizationDateTo:'2026-09-30',indicatorFilters:{region:'all',channel:'all',subchannel:'all',month:'2026-09'}};
 U.render(app,rows);
 delete global.document;
 return {html:target.innerHTML,hidden};
}
test('manager story distinguishes alerts from audits and empty data from completion',()=>{
 const r=M.compute(U.adapt(rows),{asOf:'2026-10-10'}),s=U.story(r);
 assert.equal(s.pendingAudits,1);assert.equal(s.decided,2);assert.equal(s.confirmation,.5);
 assert.match(s.headline,/2 de 3/);
 assert.match(U.story(M.compute([],{asOf:'2026-10-10'})).headline,/Sin alertas/);
 assert.doesNotMatch(U.decisionBar({total:0}),/NaN|Infinity/);
});
test('all six chapters render and legacy tables appear only under detail',()=>{
 assert.equal(U.journey.length,6);
 for(const [section] of U.journey){const {html,hidden}=render(section);assert.match(html,/aria-current="page"/);assert.equal(hidden.has('indicator-legacy-hidden'),section!=='detail');}
 assert.match(render('summary').html,/Universo de auditorías y casos en el portal/);
 assert.doesNotMatch(render('summary').html,/Reportes clásicos y exportaciones/);
 assert.match(render('detail').html,/data-indicator-download/);
 assert.match(render('pending').html,/data-indicator-bucket/);
});
test('operational benchmark includes the whole range while committee chapters use one month',()=>{
 assert.match(render('summary').html,/2 de 3 alertas/);
 assert.match(render('summary',true).html,/1 de 2 alertas/);
 assert.match(render('comparison').html,/<td>3<\/td><td>1<\/td><td>1<\/td><td>1<\/td>/);
 assert.match(render('focus',true).html,/<td>2<\/td><td>1<\/td><td>0<\/td><td>1<\/td><td>1<\/td>/);
 assert.match(render('evolution',true).html,/2026-08/);
 assert.match(render('detail',true).html,/Rechazo/);
});
test('Smart has integrated indicators and module-specific scope',()=>{
 const result=render('summary',false,'smart');assert.match(result.html,/LECTURA DE LA OPERACIÓN · SMART/);assert.doesNotMatch(result.html,/No incluye Smart/);assert.equal(result.hidden.has('indicator-legacy-hidden'),true);
});

test('Smart and Blocking retain independent decisions for the same audit ID',()=>{
 const mixed=[source(50,'2026-10-01','aplica'),{...source(50,'2026-10-01','no_aplica'),_module:'smart'}, {...source(51,'2026-10-01',null),_module:'smart'}];
 const all=M.compute(U.adapt(mixed,[],null,'all'),{asOf:'2026-10-13'});
 assert.equal(all.audits,3);assert.equal(all.counts.total,3);assert.equal(all.counts.applies,1);assert.equal(all.counts.rejects,1);assert.equal(all.counts.pending,1);
 assert.deepEqual(all.alerts.map(a=>a.module),['blocking','smart','smart']);
 const smart=M.compute(U.adapt(mixed,[],null,'smart'),{asOf:'2026-10-13'});
 assert.equal(smart.audits,2);assert.equal(smart.counts.total,2);assert.equal(smart.counts.applies,0);assert.equal(smart.counts.rejects,1);
 const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:()=>null};target.parentElement.children=[target];global.document={getElementById:()=>target};
 try {for(const module of ['smart','all'])for(const executive of [false,true]){
  const app={currentView:'visualizations',reportsSubtab:executive?'executive':'operational',getVisualizationModuleFilter:()=>module,getReportCountry:a=>a.pais};
  U.render(app,mixed);assert.match(target.innerHTML,module==='all'?/BLOQUEANTES \+ SMART/:/LECTURA.*SMART/);assert.doesNotMatch(target.innerHTML,/No incluye Smart|No fue posible calcular/);
 }}finally{delete global.document;}
});
test('new story escapes metadata and explains denominators',()=>{
 assert.equal(U.esc('<script>'), '&lt;script&gt;');
 assert.match(render('summary').html,/Recibidas = revisadas \+ pendientes/);
 assert.match(render('findings').html,/no sobre el total recibido/);
 assert.match(render('timing').html,/no son un SLA/);
});
test('monthly macro reconciles study totals, counts audit IDs once and ranks received volume',()=>{
 const r=M.compute(M.normalizeAudits([
  {id:'1',study:'Moderno',periodDate:'2026-09-01',kpis:[{name:'A',needsReview:true,decision:'aplica'},{name:'B',needsReview:true,decision:'pendiente'}]},
  {id:'2',study:'Moderno',periodDate:'2026-09-02',kpis:[{name:'A',needsReview:true,decision:'no_aplica'}]},
  {id:'1',study:'Lindley',periodDate:'2026-09-02',kpis:[{name:'A',needsReview:true,decision:'pendiente'}]}
 ]),{asOf:'2026-10-10'});
 const macro=U.macroData(r);
 assert.equal(macro.studies.reduce((n,s)=>n+s.total,0),r.counts.total);
 assert.equal(macro.studies.reduce((n,s)=>n+s.pending,0),r.counts.pending);
 assert.equal(macro.studies[0].audits,2);assert.equal(macro.variables[0].name,'A');assert.equal(macro.variables[0].total,3);
 const html=U.macroDashboard(r,'2026-09',false);
 assert.match(html,/Confirmación de alertas/);assert.match(html,/50%/);assert.match(html,/Top 3/);
 assert.doesNotMatch(html,/NaN|Infinity|Corte parcial/);
});
test('committee macro keeps month selector visible and empty data honest',()=>{
 const html=render('summary',true).html;
 assert.ok(html.indexOf('data-indicator-filter="month"')<html.indexOf('<details'));
 assert.match(html,/Dashboard general del comité/);
 assert.match(html,/Resumen para dirección/);
 const empty=U.macroDashboard(M.compute([],{asOf:'2026-10-10'}),'2026-10',true);
 assert.match(empty,/Sin base/);assert.match(empty,/Corte parcial del mes/);assert.match(empty,/Sin datos para establecer/);
 assert.doesNotMatch(empty,/NaN|Infinity/);
});

test('committee has separate chapters without changing the operation journey',()=>{
 assert.deepEqual(U.journey.map(r=>r[0]),['summary','pending','findings','comparison','timing','detail']);
 assert.deepEqual(U.committeeJourney.map(r=>r[0]),['summary','focus','evolution','detail']);
 for(const [section] of U.committeeJourney){const {html,hidden}=render(section,true);assert.match(html,/aria-current="page"/);assert.equal(hidden.has('indicator-legacy-hidden'),section!=='detail');assert.match(html,/PENDIENTES HEREDADOS/);assert.doesNotMatch(html,/NaN|Infinity/);}
 assert.doesNotMatch(render('summary').html,/PENDIENTES HEREDADOS|Decisiones propuestas/);
 assert.match(render('summary',true).html,/Total Export/);
 assert.doesNotMatch(render('summary',true).html,/Reportes clásicos y exportaciones/);
 for(const executive of [false,true])for(const section of ['summary','decisions','detail'])assert.doesNotMatch(render(section,executive).html,/Decisiones para discutir|Qué no debe concluirse aún|Qué significa y dónde actuar|Preparar decisiones|data-story-section="decisions"/);
});

test('carryover ignores date bounds, respects dimensions and never inflates month counts',()=>{
 const audits=M.normalizeAudits([
  {id:'1',study:'Moderno',periodDate:'2026-08-01',channel:'A',kpis:[{name:'X',needsReview:true}]},
  {id:'2',study:'Moderno',periodDate:'2026-08-01',channel:'B',kpis:[{name:'X',needsReview:true}]},
  {id:'3',study:'Moderno',periodDate:'2026-09-01',channel:'A',kpis:[{name:'X',needsReview:true,decision:'aplica'}]},
  {id:'4',study:'Moderno',periodDate:'2026-10-01',channel:'A',kpis:[{name:'X',needsReview:true}]}
 ]);
 const filters={asOf:'2026-10-10',from:'2026-09-01',to:'2026-09-30',channel:'A'};
 const r=M.compute(audits,filters),d=U.committeeData(r,r,audits,'2026-09',filters);
 assert.equal(r.counts.total,1);assert.equal(r.counts.pending,0);
 assert.equal(d.inherited.counts.pending,1);assert.equal(d.inherited.alerts[0].id,'1');
 assert.match(U.inheritedPanel(d,'2026-09','2026-10-10'),/État|Estado actual/);
});

test('evolution combines studies, distinguishes no decisions, and refuses partial or nonconsecutive comparisons',()=>{
 const audits=M.normalizeAudits(['2026-07-01','2026-09-01','2026-10-01'].map((periodDate,i)=>({id:String(i+1),study:'Moderno',periodDate,kpis:[{name:'K',needsReview:true}]})));
 const f={asOf:'2026-10-10',from:'2026-07-01',to:'2026-10-10'};
 const r=M.compute(audits,f),d=U.committeeData(r,r,audits,'2026-10',f);
 assert.ok(d.trend.every(r=>r.change===null));assert.ok(d.trend.every(r=>r.confirmation===null));assert.equal(d.trend.at(-1).partial,true);
 assert.match(U.committeeSection('evolution',r,d,'2026-10',true),/No comparable/);
 const empty=M.compute([],{asOf:'2026-10-10'}),e=U.committeeData(empty,empty,[],'2026-10',f);
 for(const [section] of U.committeeJourney)assert.doesNotMatch(U.committeeSection(section,empty,e,'2026-10',true),/NaN|Infinity/);
});

test('committee carries history through month and tab callbacks',()=>{
 const events=[]; const element={dataset:{storySection:'detail'},addEventListener:(name,fn)=>events.push(fn)};
 const target={innerHTML:'',querySelectorAll:selector=>selector==='[data-story-section]'?[element]:[],querySelector:()=>null};
 target.parentElement={children:[target]};global.document={getElementById:()=>target};
 const app={currentView:'visualizations',reportsSubtab:'executive',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais,indicatorFilters:{region:'all',channel:'all',subchannel:'all',month:'2026-09'},visualizationDateFrom:'2026-09-01',visualizationDateTo:'2026-09-30'};
 U.render(app,rows.slice(1),[source(99,'2026-08-01',null),...rows]);
 assert.match(target.innerHTML,/1 alertas en 1 auditorías/);
 events[0]();assert.match(target.innerHTML,/<td>99<\/td>/);
 delete global.document;
});

test('chapter navigation reuses calculations, filters recalculate, and fresh renders see in-place decisions',()=>{
 const actions={};let computations=0,classic=0;
 const original=M.compute;M.compute=(...args)=>{computations++;return original(...args);};
 const target={innerHTML:'',querySelector:()=>null,querySelectorAll:selector=>{
  if(selector==='[data-story-section]')return ['focus','evolution','detail'].map(id=>({dataset:{storySection:id},addEventListener:(_,fn)=>actions[id]=fn}));
  if(selector==='[data-indicator-filter]')return [{dataset:{indicatorFilter:'month'},value:'2026-08',addEventListener:(_,fn)=>actions.month=fn}];
  return [];
 }};
 target.parentElement={children:[target]};global.document={getElementById:()=>target};
 const records=[source(1,'2026-08-01',null),source(2,'2026-09-01',null)];
 const app={currentView:'visualizations',reportsSubtab:'executive',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais,renderClassicReports:()=>classic++,indicatorFilters:{region:'all',channel:'all',subchannel:'all',month:'2026-09'},visualizationDateFrom:'2026-08-01',visualizationDateTo:'2026-09-30'};
 try{
  U.render(app,records,records);const first=computations;
  actions.focus();actions.evolution();assert.equal(computations,first);
  actions.month();assert.ok(computations>first);assert.equal(app.indicatorFilters.month,'2026-08');
  actions.detail();assert.equal(classic,1);const detailCount=computations;
  actions.detail();assert.equal(classic,1);assert.equal(computations,detailCount);
  records[0].validationResults.K={status:'aplica'};
  app.indicatorExecutiveSection='summary';U.render(app,records,records);
  assert.ok(computations>detailCount);assert.match(target.innerHTML,/Todas las 1 alertas/);
 }finally{M.compute=original;delete global.document;}
});
