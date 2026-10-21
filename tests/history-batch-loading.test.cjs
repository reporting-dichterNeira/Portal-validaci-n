const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../js/supabase-backend.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class');
const ctx=vm.createContext({SUPABASE_CONFIG:{},Date,console});
vm.runInContext(source+'\nthis.Backend=SupabaseBackend;',ctx);
function fixture({batches=[],audits=[],scope=null,failBatch=null}={}) {
 const requests=[],progress=[];let active=0,peak=0;
 const a=Object.assign(Object.create(ctx.Backend.prototype),{configured:true,currentScope:scope,
  ensureConfigured(){},readWithRetry:request=>request(),client:{from(table){
   const filters=[],request={table,filters};requests.push(request);
   return {select(fields){request.fields=fields;return this;},eq(k,v){filters.push([k,'eq',v]);return this;},
    in(k,v){filters.push([k,'in',v]);return this;},gt(k,v){filters.push([k,'gt',v]);return this;},
    order(k){request.order=k;return this;},async limit(size){
     active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));
     try {
      const batch=filters.find(([k])=>k==='batch_id')?.[2];
      if(table==='audits' && batch===failBatch)throw new Error('timeout');
      let data=(table==='audits'?audits:batches).filter(row=>filters.every(([k,op,v])=>op==='eq'?row[k]===v:op==='in'?v.includes(row[k]):row[k]>v));
      return data.sort((a,b)=>a.id-b.id).slice(0,size);
     }finally {active--;}
    }};
  }}});
 return {a,requests,progress,get peak(){return peak;}};
}
const batch=(id,extra={})=>({id,status:'archived',module:'smart',operation_date:'2026-08-10',source_filename:'agosto.xlsx',created_at:'2026-08-10T08:00:00Z',...extra});
const audit=(id,batchId,extra={})=>({id,batch_id:batchId,module:'smart',external_id:String(10000+id),study:'Chile',payload:{kpis:[]},...extra});

test('history pages use exact batch identity, preserve metadata and globally order every audit',async()=>{
 const f=fixture({batches:[batch(1),batch(2),batch(3,{status:'failed'}),batch(4,{module:'blocking'})],
  audits:[...Array.from({length:205},(_,i)=>audit(i+1,1)),audit(400,2),audit(300,2),audit(500,3),audit(600,4,{module:'blocking'})]});
 const rows=await f.a.loadAuditHistory({module:'smart',pageSize:100,onProgress:n=>f.progress.push(n)});
 assert.equal(rows.length,207);
 assert.deepEqual(Array.from(rows,r=>Number(r.id)-10000),[...Array.from({length:205},(_,i)=>i+1),300,400]);
 assert.ok(rows.every(r=>r._batchOperationDate==='2026-08-10' && r._batchSourceFilename==='agosto.xlsx' && r._module==='smart'));
 const pages=f.requests.filter(r=>r.table==='audits');
 assert.ok(pages.every(r=>r.filters.some(([k,op])=>k==='batch_id'&&op==='eq')));
 assert.ok(pages.every(r=>!r.fields.includes('upload_batches!inner')));
 assert.deepEqual(pages.filter(r=>r.filters.some(([k,,v])=>k==='batch_id'&&v===1)).map(r=>r.filters.find(([k])=>k==='id')[2]),[0,100,200]);
 assert.ok(f.progress.every((n,i)=>i===0 || n>=f.progress[i-1]));
 assert.equal(f.progress.at(-1),207);assert.ok(f.peak<=2);
});

test('batch and audit reads both retain scope; ignoreScope still reads only visible eligible batches',async()=>{
 const batches=[batch(1,{study_id:'s1',country_id:'c1'}),batch(2,{study_id:'s2',country_id:'c2'})];
 const audits=batches.map(b=>audit(b.id,b.id,{study_id:b.study_id,country_id:b.country_id}));
 const f=fixture({batches,audits,scope:{study:{id:'s1'},country:{id:'c1'}}});
 assert.equal((await f.a.loadAuditHistory({module:'smart'})).length,1);
 assert.ok(f.requests.every(r=>r.filters.some(([k,,v])=>k==='study_id'&&v==='s1') && r.filters.some(([k,,v])=>k==='country_id'&&v==='c1')));
 f.requests.length=0;
 assert.equal((await f.a.loadAuditHistory({module:'smart',ignoreScope:true})).length,2);
 assert.ok(f.requests.every(r=>!r.filters.some(([k])=>['study_id','country_id'].includes(k))));
});

test('batch catalog paginates past 1000 and empty/error histories never return partial success',async()=>{
 const f=fixture({batches:Array.from({length:1001},(_,i)=>batch(i+1)),audits:[audit(1,1001)]});
 assert.equal((await f.a.loadAuditHistory({module:'smart'})).length,1);
 assert.deepEqual(f.requests.filter(r=>r.table==='upload_batches').map(r=>r.filters.find(([k])=>k==='id')[2]),[0,1000]);
 assert.deepEqual(Array.from(await fixture().a.loadAuditHistory()),[]);
 const failed=fixture({batches:[batch(1),batch(2)],audits:[audit(1,1)],failBatch:2});
 await assert.rejects(failed.a.loadAuditHistory({module:'smart'}),/timeout/);
});
