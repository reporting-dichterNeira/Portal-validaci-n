// Local browser smoke test with synthetic data; never changes production reviews.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
const script=`
import {PqrUI} from '/js/pqr-ui.mjs';
const row={id:'review1',external_id:'123',day:'2026-11-17',study:'Chile',country:'Chile',validator_name:'Validador de prueba',analyst_id:'a1',analyst_name:'Analista QA',alert_name:'Precio',alert_count:1,invalid_count:1,reasons:{fast:true},status:'pending',version:1,kpis:[{name:'Precio'}],original_results:{Precio:{status:'no_aplica'}},review_results:{}};
let ctx={role:'supervisor',name:'Supervisión de prueba'},analysts=[{id:'a1',name:'Analista QA',active:true,available:true}],settings=['Chile','Moderno','Tradicional','Lindley'].map(study=>({study,analyst_id:'a1',percentage:35}));
const backend={operation:'pqr',setOperation(op){this.operation=op},async restore(){return ctx},async login(kind){ctx={role:kind==='supervisor'?'supervisor':kind==='admin'?'admin':'analyst',id:'a1',name:'Prueba'};this.operation=kind==='qa'?'qa':'pqr';return ctx},async logout(){ctx=null},async call(action,p={}){
window.lastAction={operation:this.operation,action,data:p};
if(action==='study_settings'){settings=p.studies;return {}};
if(action==='create_analyst'){analysts.push({id:'a2',name:p.name,active:true,available:true});return {id:'a2',code:'QA-ABCDEFGH2345'}};
if(action==='get_code')return {code:'QA-ABCDEFGH2345'};
if(action==='start'){row.status='in_progress';row.version++;return row};
if(action==='detail')return row;
if(action==='save'){row.review_results=p.results;row.version++;if(p.complete){row.status='completed';row.verdict='correct';row.completed_at=new Date().toISOString()}return row};
return {context:ctx,day:'2026-11-17',today:'2026-11-17',stats:{eligible:184,target:65,percentage:35,selected:65,assigned:65,completed:row.status==='completed'?1:0},settings:{auto_assign:true},study_settings:settings,study_stats:settings.map(s=>({...s,eligible:46,target:16,selected:16})),analysts,reviews:[row],supervisors:[]};
}};
window.testUI=new PqrUI(document.getElementById('pqr-app'),backend);await window.testUI.init();
window.testRole=async role=>{ctx={role,id:'a1',name:'Prueba'};window.testUI.detail=null;await window.testUI.load()};
`;
const html=fs.readFileSync(path.join(root,'pqr.html'),'utf8').replace(/<script type="module" src="js\/pqr-app.js\?v=[^"]+"><\/script>/,`<script type="module">${script}</script>`);
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html)}const f=path.resolve(root,'.'+u.pathname);if(!f.startsWith(root+path.sep)||!fs.existsSync(f)){res.statusCode=404;return res.end()}res.setHeader('Content-Type',(f.endsWith('.mjs')||f.endsWith('.js'))?'text/javascript':f.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(f))});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-operation="qa"]').click();await page.getByRole('heading',{name:'Operación QA',exact:true}).waitFor();

 for(const operation of ['qa','pqr']){
  if(operation==='pqr')await page.locator('[data-operation="pqr"]').click();
  const studies=page.locator('[data-multi-name="study"]');await studies.locator('summary').click();
  await studies.locator('[value="Chile"][data-multi-option]').check();await studies.locator('[value="Lindley"][data-multi-option]').check();await studies.locator('[data-multi-apply]').click();
  const statuses=page.locator('[data-multi-name="status"]');await statuses.locator('summary').click();await statuses.locator('[value="completed"][data-multi-option]').check();await statuses.locator('[value="in_progress"][data-multi-option]').check();
  await page.locator('#pqr-filter-form button[type="submit"]').click();
  assert.deepEqual(await page.evaluate(()=>lastAction.data.study),['Chile','Lindley']);assert.deepEqual(await page.evaluate(()=>lastAction.data.status),['in_progress','completed']);
 }
 await page.locator('[data-operation="qa"]').click();
 await page.locator('[name="qa_percentage"]').fill('40');await page.locator('#pqr-settings button[type="submit"]').click();assert.equal(await page.evaluate(()=>lastAction.operation),'qa');
 await page.locator('#pqr-create-analyst input').fill('Analista nuevo QA');await page.locator('#pqr-create-analyst button').click();await page.locator('#pqr-secret[open]').waitFor();assert.equal(await page.locator('#pqr-secret-value').textContent(),'QA-ABCDEFGH2345');await page.locator('#pqr-close-secret').click();
 await page.locator('[data-operation="pqr"]').click();await page.getByRole('heading',{name:'Operación PQR',exact:true}).waitFor();assert.equal(await page.locator('[name="qa_percentage"]').count(),0);
 await page.evaluate(()=>testRole('admin'));await page.locator('[data-operation="qa"]').click();await page.getByRole('heading',{name:'Operación QA',exact:true}).waitFor();assert.equal(await page.locator('#pqr-create-supervisor').count(),1);
 await page.screenshot({path:path.join(root,'tmp/qa-admin-verified.png'),fullPage:true});
 await page.evaluate(()=>testRole('analyst'));assert.equal(await page.locator('[data-operation]').count(),0);await page.locator('[data-open="review1"]').click();await page.getByText('Alerta no válida · No aplica',{exact:true}).waitFor();await page.locator('[name="evaluation_0"][value="correct"]').check();await page.locator('button[value="complete"]').click();await page.getByText('Revisión terminada. Validación correcta',{exact:true}).waitFor();
 await page.locator('[data-action="back"]').click();await page.getByRole('heading',{name:'Mis revisiones QA'}).waitFor();assert.equal(await page.evaluate(()=>lastAction.operation),'qa');
 await page.locator('[data-action="logout"]').click();await page.locator('[data-login-mode="qa"]').click();assert.equal(await page.locator('input[name="code"]').getAttribute('placeholder'),'QA-…');

 // Render the actual metrics dashboard and exercise the same dropdown widgets.
 await page.addScriptTag({path:path.join(root,'js/indicator-metrics.js')});await page.addScriptTag({path:path.join(root,'js/indicator-dashboard.js')});
 await page.evaluate(()=>{
  document.body.innerHTML='<main><div id="indicators-operational"></div></main>';
  window.metricRows=[['1','2026-08-01','TEMUCO'],['2','2026-09-01','TALCA'],['3','2026-10-01','IQUIQUE']].map(([id,fecha,region])=>({id,fecha,region,fechaAuditoriaOriginal:fecha,estudio:'Chile',pais:'Chile',_module:'blocking',kpis:[{name:'KPI',needsReview:true}],validationResults:{KPI:{status:'aplica'}}}));
  window.metricApp={currentView:'visualizations',currentRole:'admin',selectedStudies:['ALL'],selectedMetricsMonth:'all',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais,getMetricsScopeOptions:()=>({studies:[{value:'Chile',label:'Chile'}],countries:[{value:'Chile',label:'Chile'}],months:['2026-08','2026-09','2026-10'].map(value=>({value,label:value}))}),setMetricsScopeFilter(key,value){if(key==='month')this.selectedMetricsMonth=value;window.PortalIndicators.render(this,metricRows);}};
  PortalIndicators.render(metricApp,metricRows);
 });
 const months=page.locator('[data-metric-scope-filter="month"]');await months.locator('summary').click();await months.locator('[value="2026-08"][data-multi-option]').check();await months.locator('[value="2026-09"][data-multi-option]').check();await months.locator('[data-multi-apply]').click();
 assert.deepEqual(await page.evaluate(()=>metricApp.selectedMetricsMonth),['2026-08','2026-09']);assert.match(await page.locator('#indicators-operational').innerText(),/Todas las 2 alertas/);
 await page.locator('.story-filters > summary').click();const regions=page.locator('[data-indicator-filter="region"]');await regions.locator('summary').click();await regions.locator('[value="TEMUCO"][data-multi-option]').check();await regions.locator('[data-multi-apply]').click();assert.match(await page.locator('#indicators-operational').innerText(),/Todas las 1 alertas/);
 const reset=page.locator('[data-indicator-filter="region"]');await reset.locator('summary').click();await reset.locator('[data-multi-all]').check();await reset.locator('[data-multi-apply]').click();assert.match(await page.locator('#indicators-operational').innerText(),/Todas las 2 alertas/);
 await page.screenshot({path:path.join(root,'tmp/multiple-metrics-verified.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: supervisor/admin sheets, QA configuration, analyst code, original decision, completion and return, PQR switch, QA login.');
}finally{await browser?.close();server.close()}})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
