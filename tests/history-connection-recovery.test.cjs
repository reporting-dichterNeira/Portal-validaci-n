const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../js/supabase-backend.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class');
function setup(reply) {
 const queries=[],progress=[],delays=[];let refreshes=0;
 const ctx=vm.createContext({SUPABASE_CONFIG:{},Date,setTimeout(fn,ms){delays.push(ms);queueMicrotask(fn);}});
 vm.runInContext(source+'\nthis.Backend=SupabaseBackend;',ctx);
 const backend=Object.assign(Object.create(ctx.Backend.prototype),{ensureConfigured(){},currentScope:{study:{id:'s'},country:{id:'c'}}});
 backend.client={auth:{async getSession(){return {data:{session:{expires_at:Date.now()/1000+3600}}};},async refreshSession(){refreshes++;return {data:{session:{}}};}},from(table){
  const query={table,filters:{}};
  return {select(){return this;},in(k,v){query.filters[k]=v;return this;},eq(k,v){query.filters[k]=v;return this;},gt(k,v){query.cursor=v;return this;},order(){return this;},limit(n){query.limit=n;return this;},
   then(resolve,reject){queries.push(query);return Promise.resolve().then(()=>reply(query,queries.length)).then(resolve,reject);}};
 }};
 return {backend,queries,progress,delays,refreshes:()=>refreshes};
}
const page=(start,length)=>Array.from({length},(_,i)=>({id:start+i,external_id:String(start+i),module:'smart',payload:{},upload_batches:{operation_date:'2026-10-19'}}));
test('history retries the failed page without losing rows or repeating prior pages, preserving module and scope',async()=>{
 let failed=false;
 const s=setup(q=>q.cursor===0?{data:page(1,100)}:!failed?(failed=true,{error:{code:'57014',message:'statement timeout'}}):{data:page(101,7)});
 const rows=await s.backend.loadAuditHistory({module:'smart',pageSize:100,onProgress:n=>s.progress.push(n)});
 assert.equal(rows.length,107);assert.equal(new Set(rows.map(r=>r.id)).size,107);
 assert.deepEqual(s.queries.map(q=>q.cursor),[0,100,100]);assert.deepEqual(s.progress,[100,107]);assert.deepEqual(s.delays,[350]);
 assert.ok(s.queries.every(q=>q.filters.module==='smart' && q.filters.study_id==='s' && q.filters.country_id==='c'));
});
test('history renews an expired JWT once and rebuilds the same page request',async()=>{
 const s=setup((_q,n)=>n===1?{error:{message:'JWT expired'}}:{data:page(1,2)});
 const rows=await s.backend.loadAuditHistory({module:'blocking'});
 assert.equal(rows.length,2);assert.equal(s.refreshes(),1);assert.deepEqual(s.queries.map(q=>q.cursor),[0,0]);
});
test('history fails explicitly after bounded transient failures or immediately on permission denial',async()=>{
 const s=setup(q=>q.cursor===0?{data:page(1,100)}:{error:{code:'57014',message:'timeout'}});
 await assert.rejects(s.backend.loadAuditHistory({pageSize:100}),e=>e.metricsRetryable===true);
 assert.deepEqual(s.queries.map(q=>q.cursor),[0,100,100,100]);
 const denied=setup(()=>({error:{code:'42501',message:'Forbidden'}}));
 await assert.rejects(denied.backend.loadAuditHistory(),e=>e.code==='42501');assert.equal(denied.queries.length,1);assert.equal(denied.refreshes(),0);
});
