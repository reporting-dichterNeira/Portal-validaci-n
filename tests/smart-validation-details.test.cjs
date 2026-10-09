const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const nodes=new Map();
const sheets=[];
const context=vm.createContext({console,Date,setTimeout:()=>0,
  formatNicaraguaDateTime:value=>String(value||''),getNicaraguaDateKey:()=> '2026-10-09',
  SUPABASE_CONFIG:{},document:{getElementById:id=>nodes.get(id)||null},
  XLSX:{utils:{book_new:()=>({}),json_to_sheet:rows=>{sheets.push(rows);return{};},book_append_sheet(){}},writeFile(){} }
});
for(const [file,name] of [['validator-ui.js','ValidatorUI'],['supabase-backend.js','SupabaseBackend'],['excel-parser.js','ExcelParser']]){
  const code=fs.readFileSync(path.join(root,'js',file),'utf8').replace(/^import .*;\r?\n/gm,'').replace(`export class ${name}`,`class ${name}`);
  vm.runInContext(code+`\nthis.${name}=${name};`,context);
}
const {ValidatorUI,ExcelParser,SupabaseBackend}=context;
const audit=()=>({id:'999001',_rowId:999001,_module:'smart',estudio:'Moderno',assignedValidatorId:'fixture',
  fecha:'2026-10-09',validationStatus:'en_progreso',kpis:[{name:'Alerta precio',needsReview:true}],validationResults:{}});
function instance(module='smart'){
  const calls=[];
  const ui=Object.assign(Object.create(ValidatorUI.prototype),{currentModule:module,currentAuditId:'999001',currentAuditNeedsSave:true,
    app:{getTipificacionesForDecision:()=>['Tipo de prueba'],saveState(){},smartAudits:[],blockingAudits:[],showToast:(...args)=>calls.push(args),
      syncStateAcrossTabs:async ({audit:a,module:m})=>{calls.push({saved:JSON.parse(JSON.stringify(a)),module:m});return a;}}
  });
  ui.auditDetailContainer={innerHTML:'',classList:{add(){},remove(){}},querySelector:()=>null,querySelectorAll:()=>[]};
  ui.noAuditSelectedView={classList:{add(){},remove(){}}};
  ui.renderAuditList=ui.updateProgressHeader=ui.showCelebrationModal=()=>{};
  ui.loadProductivity=async()=>{};ui.getMyAudits=()=>[];
  return {ui,calls};
}
test('Smart muestra botón al lado de Consultar, detalle opcional y comentario general, sin selector de tipología',()=>{
  const {ui}=instance(),a=audit();ui.bindDetailEvents=()=>{};ui.renderAuditDetail(a);
  const html=ui.auditDetailContainer.innerHTML;
  assert.ok(!html.includes('tipif_select_'));
  assert.ok(html.includes('kpi_detail_toggle_0'));
  assert.ok(html.indexOf('kpi-btn-doubt')<html.indexOf('kpi_detail_toggle_0'));
  assert.ok(html.includes('id="kpi_detail_box_0"'));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('id="smart-audit-comment"'));
});
test('Bloqueantes conserva su selector y no recibe botón ni comentario general Smart',()=>{
  const {ui}=instance('blocking');ui.bindDetailEvents=()=>{};ui.renderAuditDetail(audit());
  const html=ui.auditDetailContainer.innerHTML;
  assert.ok(html.includes('tipif_select_0'));
  assert.ok(!html.includes('kpi_detail_toggle_0'));
  assert.ok(!html.includes('id="smart-audit-comment"'));
});
test('Smart completa Aplica y No aplica sin tipología ni comentarios; Bloqueantes sigue exigiéndola',async()=>{
  for(const decision of ['aplica','no_aplica']){
    const a=audit();a.validationResults['Alerta precio']={status:decision,tipificacion:''};
    const {ui,calls}=instance();await ui.completeAndAdvance(a,a.kpis);
    assert.equal(a.validationStatus,'completada');assert.equal(calls.filter(c=>c.saved).length,1);
    const blocking=instance('blocking'),b=audit();b.validationResults['Alerta precio']={status:decision,tipificacion:''};
    await blocking.ui.completeAndAdvance(b,b.kpis);
    assert.equal(b.validationStatus,'en_progreso');assert.equal(blocking.calls.filter(c=>c.saved).length,0);
    assert.match(blocking.calls[0][0],/tipología/);
  }
});
test('Smart sigue exigiendo una respuesta por KPI; Consultar no se vuelve una decisión final',async()=>{
  const {ui,calls}=instance(),a=audit();await ui.completeAndAdvance(a,a.kpis);
  assert.equal(calls.filter(c=>c.saved).length,0);assert.match(calls[0][0],/por responder/);
  a.validationResults['Alerta precio']={status:'duda',dudaText:'Verificar fotografía'};
  await ui.completeAndAdvance(a,a.kpis);assert.equal(a.validationStatus,'en_progreso');assert.equal(a.completedAt,null);
});
test('comentario general sobrevive al RPC existente y a la lectura, sin cambios de permisos ni payload de auditoría',async()=>{
  const {ui}=instance(),a=audit();ui.setSmartGeneralComment(a,'Comprobar contexto de la tienda');
  a.validationResults['Alerta precio']={status:'no_aplica',observaciones:'Detalle de prueba'};
  let parameters;
  const backend=Object.assign(Object.create(SupabaseBackend.prototype),{configured:true,ensureFreshSessionForWrite:async()=>{},client:{
    rpc:async(name,p)=>{assert.equal(name,'save_audit_progress_v2');parameters=p;return{error:null,data:{id:999001,external_id:a.id,study:'Moderno',module:'smart',status:'completada',payload:{pais:'Panamá'},validation_results:JSON.parse(JSON.stringify(p.p_validation_results))}};}
  }});
  const restored=await backend.saveAuditProgress(a,'smart');
  assert.equal(restored.validationResults.__audit__.comentarioGeneral,'Comprobar contexto de la tienda');
  assert.equal(restored.validationResults['Alerta precio'].observaciones,'Detalle de prueba');
  assert.equal(parameters.p_validation_results.__audit__.status,undefined);
  assert.equal(parameters.p_payload,undefined);
});
test('recoger el formulario conserva detalle, comentario y tipología histórica sin cambio de decisión',()=>{
  const {ui}=instance(),a=audit();a.validationResults['Alerta precio']={status:'aplica',tipificacion:'Tipo histórico',decisionAt:'2026-10-09T12:00:00Z'};
  const fields={'input[value="aplica"]':{checked:true},'#obs_0':{value:'Detalle opcional'}};
  ui.auditDetailContainer.querySelectorAll=()=>[{dataset:{kpi:'Alerta precio'},querySelector:key=>fields[key]||null}];
  ui.auditDetailContainer.querySelector=()=>({value:'Comentario general'});
  ui.collectFormData(a);
  assert.equal(a.validationResults['Alerta precio'].observaciones,'Detalle opcional');
  assert.equal(a.validationResults['Alerta precio'].tipificacion,'Tipo histórico');
  assert.equal(a.validationResults['Alerta precio'].decisionAt,'2026-10-09T12:00:00Z');
  assert.equal(a.validationResults.__audit__.comentarioGeneral,'Comentario general');
});
test('un detalle de KPI consultado se conserva también al guardar y los comentarios se pueden vaciar',()=>{
  const {ui}=instance(),a=audit();
  const fields={'input[value="duda"]':{checked:true},'#obs_0':{value:'Detalle adicional'},'#duda_input_0':{value:'Pregunta al supervisor'}};
  ui.auditDetailContainer.querySelectorAll=()=>[{dataset:{kpi:'Alerta precio'},querySelector:key=>fields[key]||null}];ui.collectFormData(a);
  assert.equal(a.validationResults['Alerta precio'].observaciones,'Detalle adicional');
  ui.setSmartGeneralComment(a,'Comentario');ui.setSmartGeneralComment(a,'');assert.equal(a.validationResults.__audit__.comentarioGeneral,'');
  const blocking=instance('blocking');blocking.ui.setSmartGeneralComment(audit(),'No debe guardarse');
});
test('comentarios guardados se reabren como texto seguro, sin interpretar HTML',()=>{
  const {ui}=instance(),a=audit();a.validationResults['Alerta precio']={observaciones:'</textarea><img src=x onerror=alert(1)>'};
  ui.setSmartGeneralComment(a,'</textarea><script>prueba</script>');ui.bindDetailEvents=()=>{};ui.renderAuditDetail(a);
  const html=ui.auditDetailContainer.innerHTML;
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes('&lt;/textarea&gt;&lt;script&gt;prueba&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x onerror='));
});
test('export incluye comentario general Smart y el detalle por KPI; metadata no infla el total de KPIs',()=>{
  const {ui}=instance(),a=audit();a.validationStatus='completada';a.validationResults['Alerta precio']={status:'aplica',observaciones:'Detalle'};ui.setSmartGeneralComment(a,'Comentario');
  const [exported]=ExcelParser.buildConsolidatedExportRows([a],[]);
  assert.equal(exported['Comentario general Smart'],'Comentario');assert.equal(exported['[Alerta precio] Observaciones'],'Detalle');assert.equal(exported['KPIs a Revisar (Total)'],1);
  const b={...audit(),_module:'blocking'};assert.equal(ExcelParser.buildConsolidatedExportRows([b],[])[0]['Comentario general Smart'],undefined);
  sheets.length=0;ExcelParser.exportResultsToExcel([a],[{id:'fixture',name:'Validador prueba',code:'VAL-TEST'}]);
  assert.equal(sheets[1][0]['KPIs Validados Aplica'],1);
  assert.equal(sheets[1][0]['KPIs Validados No Aplica'],0);
});
