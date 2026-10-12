const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'js/pending-workspace.js'),'utf8'),ctx);
test('seguimiento separa cargas con el mismo nombre y jornada, y reúne la carga original reasignada',()=>{
 const rows=[{id:1,batch_id:7,source_filename:'Base.xlsx',operation_date:'2026-10-11'},
 {id:2,batch_id:8,source_filename:'Base.xlsx',operation_date:'2026-10-11'},
 {id:3,batch_id:9,load_batch_id:7,source_filename:'Base.xlsx',operation_date:'2026-10-11'}];
 const groups=ctx.PortalPending.groupLoads(rows);
 assert.deepEqual(Array.from(groups,g=>Array.from(g,a=>a.id)),[[1,3],[2]]);
});
test('pendientes por KPI excluye decisiones terminadas pero conserva los detalles sin decidir',()=>{
 const a={payload:{kpis:[{name:'A',needsReview:true},{name:'B',needsReview:true},{name:'C',needsReview:false}]},validation_results:{A:{status:'no_aplica'},B:{comment:'Revisar imagen'}}};
 assert.deepEqual(Array.from(ctx.PortalPending.pendingKpis(a),k=>k.name),['B']);
});
