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
 assert.doesNotMatch(render('summary').html,/<table/);
 assert.match(render('detail').html,/data-indicator-download/);
 assert.match(render('pending').html,/data-indicator-bucket/);
});
test('operational benchmark includes the whole range while committee chapters use one month',()=>{
 assert.match(render('summary').html,/2 de 3 alertas/);
 assert.match(render('summary',true).html,/1 de 2 alertas/);
 assert.match(render('comparison').html,/<td>3<\/td><td>1<\/td><td>1<\/td><td>1<\/td>/);
 assert.match(render('comparison',true).html,/<td>2<\/td><td>0<\/td><td>1<\/td><td>1<\/td>/);
 assert.match(render('comparison',true).html,/2026-08/);
 assert.match(render('findings',true).html,/Rechazo/);
});
test('Smart retains the existing dashboard without blocking-only navigation',()=>{
 const result=render('summary',false,'smart');assert.equal(result.html,'');assert.equal(result.hidden.size,0);
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
 assert.match(html,/Comparativa macro por estudio/);
 const empty=U.macroDashboard(M.compute([],{asOf:'2026-10-10'}),'2026-10',true);
 assert.match(empty,/Sin base/);assert.match(empty,/Corte parcial del mes/);assert.match(empty,/Sin datos para establecer/);
 assert.doesNotMatch(empty,/NaN|Infinity/);
});
