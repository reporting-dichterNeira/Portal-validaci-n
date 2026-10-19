const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const source=fs.readFileSync(require.resolve('../js/supabase-backend.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class');
function backend(responses,{expires=Date.now()/1000+3600,session=true}={}) {
 const calls={rpc:0,refresh:0,delays:[]};
 const ctx=vm.createContext({SUPABASE_CONFIG:{},Date,setTimeout(fn,ms){calls.delays.push(ms);queueMicrotask(fn);}});
 vm.runInContext(source+'\nthis.Backend=SupabaseBackend;',ctx);
 const a=Object.assign(Object.create(ctx.Backend.prototype),{configured:true,client:{auth:{
 async getSession(){return {data:{session:session?{expires_at:expires}:null}};},
 async refreshSession(){calls.refresh++;return {data:{session:{expires_at:Date.now()/1000+3600}}};}
 },async rpc(name,args){assert.equal(name,'get_databricks_audit_totals');calls.rpc++;const next=responses.shift();if(next instanceof Error)throw next;return next;}}});
 return {a,calls};
}
test('totals recover from timeout/network failures, use bounded backoff and refresh near-expiry sessions',async()=>{
 const {a,calls}=backend([{error:{code:'57014',message:'statement timeout'}},new TypeError('Failed to fetch'),{data:{ok:true}}],{expires:Date.now()/1000+30});
 assert.equal((await a.loadDatabricksAuditTotals({month:'2026-10'})).ok,true);
 assert.equal(calls.rpc,3);assert.equal(calls.refresh,1);assert.deepEqual(calls.delays,[350,700]);
});
test('permission and missing-session errors do not retry; expired JWT renews once; persistent failures are bounded',async()=>{
 const denied=backend([{error:{code:'42501',message:'VISUALIZATION_ACCESS_REQUIRED'}}]);
 await assert.rejects(denied.a.loadDatabricksAuditTotals({}),e=>e.code==='42501');assert.equal(denied.calls.rpc,1);assert.equal(denied.calls.refresh,0);
 const missing=backend([],{session:false});await assert.rejects(missing.a.loadDatabricksAuditTotals({}),/sesión venció/);assert.equal(missing.calls.rpc,0);
 const expired=backend([{error:{message:'JWT expired'}},{data:{ok:true}}]);await expired.a.loadDatabricksAuditTotals({});assert.equal(expired.calls.refresh,1);assert.equal(expired.calls.rpc,2);
 const offline=backend(Array.from({length:3},()=>({error:{code:'57014',message:'timeout'}})));
 await assert.rejects(offline.a.loadDatabricksAuditTotals({}),e=>e.metricsRetryable===true);assert.equal(offline.calls.rpc,3);
});
const good={studies:[{study_name:'Chile',databricks_total:100}],snapshots:[{month:'2026-10',source:'Databricks',refreshed_at:'2026-10-19'}]};
const rows=[{id:'1',estudio:'Chile',fecha:'2026-10-01',kpis:[]}];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('overlapping totals requests share a single session renewal',async()=>{
 const {a,calls}=backend([{data:{total:1}},{data:{total:2}}],{expires:Date.now()/1000+30});
 let release;
 a.client.auth.refreshSession=()=>{calls.refresh++;return new Promise(resolve=>release=()=>resolve({data:{session:{}}}));};
 const first=a.loadDatabricksAuditTotals({studies:['Chile']}),second=a.loadDatabricksAuditTotals({studies:['Lindley']});
 await tick();assert.equal(calls.refresh,1);release();
 assert.deepEqual((await Promise.all([first,second])).map(x=>x.total),[1,2]);assert.equal(calls.rpc,2);
});
test('refresh coalesces requests, keeps the same-filter total with a warning on transient failure and retries once automatically',async()=>{
 let now=Date.now(),pending,calls=0;const timers=[],originalNow=Date.now,originalTimer=global.setTimeout;
 const target={innerHTML:'',parentElement:{children:[]},querySelectorAll:()=>[],querySelector:()=>null};
 const app={currentRole:'commercial',currentProfile:{username:'user'},currentView:'visualizations',reportsSubtab:'metrics',selectedMetricsMonth:'2026-10',selectedStudies:['Chile'],
 getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',backend:{configured:true,loadDatabricksAuditTotals(){calls++;if(calls===2)return new Promise((_resolve,reject)=>pending=reject);return Promise.resolve(good);}},renderReportsView(){U.render(app,rows);}};
 global.document={getElementById:()=>target};Date.now=()=>now;global.setTimeout=(fn,ms)=>{timers.push({fn,ms});return {unref(){}};};
 try {
  app.renderReportsView();app.renderReportsView();await tick();assert.equal(calls,1);
  now+=300001;app.renderReportsView();app.renderReportsView();assert.equal(calls,2);assert.match(target.innerHTML,/Total levantado<\/span><strong class="stat-value">100/);
  pending(Object.assign(new Error('timeout'),{metricsRetryable:true}));await tick();app.renderReportsView();
  assert.equal(calls,2);assert.match(target.innerHTML,/último dato consultado/);assert.doesNotMatch(target.innerHTML,/Error al consultar/);assert.equal(timers.length,1);
  now+=16000;timers[0].fn();await tick();app.renderReportsView();assert.equal(calls,3);assert.doesNotMatch(target.innerHTML,/último dato consultado/);
  app.selectedMetricsCountry='Perú';app.backend.loadDatabricksAuditTotals=async()=>{throw Object.assign(new Error('timeout'),{metricsRetryable:true});};
  app.renderReportsView();await tick();app.renderReportsView();assert.match(target.innerHTML,/Error al consultar/);assert.doesNotMatch(target.innerHTML,/último dato consultado/);
  app.currentProfile={username:'other'};app.selectedMetricsCountry='all';app.renderReportsView();await tick();app.renderReportsView();assert.match(target.innerHTML,/Error al consultar/);
 }finally{Date.now=originalNow;global.setTimeout=originalTimer;delete global.document;}
});
