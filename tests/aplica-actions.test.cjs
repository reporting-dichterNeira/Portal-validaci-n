const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('../js/indicator-metrics.js');
const nodes=new Map();
const ctx=vm.createContext({console,Date,setTimeout:()=>0,clearTimeout,PortalIndicatorMetrics:M,
 document:{getElementById:id=>nodes.get(id)||null},SUPABASE_CONFIG:{},formatNicaraguaDateTime:v=>v||'',getNicaraguaDateKey:()=> '2026-10-20'});
vm.runInContext(fs.readFileSync(require.resolve('../js/sample-data.js'),'utf8').replace(/export /g,'')+'\nthis.catalog=TIPIFICACIONES_POR_DECISION;',ctx);
for(const [file,name] of [['validator-ui.js','ValidatorUI'],['supabase-backend.js','SupabaseBackend'],['excel-parser.js','ExcelParser']]) {
 const source=fs.readFileSync(require.resolve('../js/'+file),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class');
 vm.runInContext(source+'\nthis.'+name+'='+name+';',ctx);
}
const source=fs.readFileSync(require.resolve('../js/app.js'),'utf8');
vm.runInContext(source.slice(0,source.indexOf('// Inicializar la aplicación inmediatamente')).replace(/^import .*;\r?\n/gm,'')+'\nthis.App=ValidaFlowApp;',ctx);
const actions=['Alerta válida: encuesta editada','Alerta válida: encuesta cancelada','Alerta válida: sin cambios requeridos'];
const audit=tipificacion=>({id:'999002',_rowId:999002,_module:'blocking',estudio:'Chile',pais:'Chile',fecha:'2026-10-20',fechaAuditoriaOriginal:'2026-10-19',
 kpis:[{name:'KPI 1',needsReview:true}],validationResults:{'KPI 1':{status:'aplica',tipificacion}}});
function render(a) {
 const ui=Object.assign(Object.create(ctx.ValidatorUI.prototype),{currentModule:'blocking',app:{getTipificacionesForDecision:d=>ctx.catalog[d]},
  auditDetailContainer:{innerHTML:'',classList:{remove(){}}},noAuditSelectedView:{classList:{add(){}}},bindDetailEvents(){}});
 ui.renderAuditDetail(a);return ui.auditDetailContainer.innerHTML;
}
test('Aplica offers the three action classifications and reopens the selected action',()=>{
 assert.deepEqual(Array.from(ctx.catalog.aplica),actions);
 for(const action of actions) {
  const html=render(audit(action));
  assert.match(html,/Acción realizada tras confirmar la alerta/);
  assert.match(html,/tipificacion-container visible/);
  assert.ok(html.includes('value="'+action+'" selected'));
  assert.doesNotMatch(html,/Evidencia de campo confirma la alerta/);
 }
 assert.equal(ctx.catalog.no_aplica[0],'Falso positivo: evidencia de campo correcta');
});
test('historical classifications survive reopening and are escaped as text',()=>{
 const a=audit('Evidencia de campo confirma la alerta'),before=JSON.stringify(a);
 assert.match(render(a),/value="Evidencia de campo confirma la alerta" selected/);
 assert.equal(JSON.stringify(a),before);
 const html=render(audit('"><img src=x onerror=alert(1)>'));
 assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
});
test('supervisor resolution uses the same actions and retains historical selections',()=>{
 const select={innerHTML:''},label={textContent:''};nodes.set('modal-resolve-tipif',select);nodes.set('modal-resolve-tipif-label',label);
 const app=Object.create(ctx.App.prototype);
 app.populateResolveTipificationOptions('aplica',actions[1]);
 assert.ok(select.innerHTML.includes('value="'+actions[1]+'" selected'));
 assert.match(label.textContent,/Acción realizada/);
 app.populateResolveTipificationOptions('aplica','Tipificación anterior');
 assert.match(select.innerHTML,/value="Tipificación anterior" selected/);
 app.populateResolveTipificationOptions('no_aplica');assert.doesNotMatch(select.innerHTML,/encuesta editada/);
 nodes.clear();
});
test('each action survives the existing save/read RPC and consolidated CSV roundtrip',async()=>{
 for(const action of actions) {
  const a=audit(action);let parameters;
  const backend=Object.assign(Object.create(ctx.SupabaseBackend.prototype),{configured:true,ensureFreshSessionForWrite:async()=>{},client:{rpc:async(name,p)=>{
   assert.equal(name,'save_audit_progress_v2');parameters=p;
   return {error:null,data:{id:999002,external_id:a.id,study:'Chile',module:'blocking',status:'completada',payload:{...a,pais:'Chile'},validation_results:JSON.parse(JSON.stringify(p.p_validation_results))}};
  }}});
  const restored=await backend.saveAuditProgress(a,'blocking');
  assert.equal(restored.validationResults['KPI 1'].tipificacion,action);
  assert.equal(parameters.p_validation_results['KPI 1'].status,'aplica');
  const [row]=ctx.ExcelParser.buildConsolidatedExportRows([a],[]);
  assert.equal(row['[KPI 1] Tipificación'],action);
  assert.equal(row['[KPI 1] Tipificación No Aplica'],undefined);
  const csv=Object.keys(row).map(v=>'"'+v.replace(/"/g,'""')+'"').join(';')+'\n'+Object.values(row).map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(';');
  assert.equal(M.readConsolidatedCSV(csv)[0].kpis[0].reason,action);
  assert.equal(M.readConsolidatedCSV(csv.replace('[KPI 1] Tipificación','[KPI 1] Tipificación No Aplica'))[0].kpis[0].reason,action);
 }
});
