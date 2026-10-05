const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const context = vm.createContext({ console, SUPABASE_CONFIG: {}, getStudyDisplayName: value => value, document: { getElementById: () => null } });
for (const [file, name] of [['excel-parser.js','ExcelParser'],['distributor.js','Distributor'],['supabase-backend.js','SupabaseBackend']]) {
  const source = fs.readFileSync(path.join(root,'js',file),'utf8').replace(/^import .*;\r?\n/gm,'').replace(`export class ${name}`,`class ${name}`);
  vm.runInContext(source + `\nthis.${name}=${name};`, context);
}
const appCode = fs.readFileSync(path.join(root,'js/app.js'),'utf8');
vm.runInContext(appCode.slice(0,appCode.indexOf('// Inicializar la aplicación inmediatamente')).replace(/^import .*;\r?\n/gm,'')+'\nthis.App=ValidaFlowApp;',context);
const { ExcelParser, Distributor, SupabaseBackend, App } = context;
const audit = (id,pais) => ({id:String(id),pais,kpis:[{needsReview:true}],validationStatus:'pendiente'});
const options = {restrictByCountry:true};

test('Smart reparte Panamá solo a validadores habilitados, sin cuota global que bloquee países', () => {
  const validators=[{id:'panama',smartCountry:'Panamá'},{id:'cr',smartCountry:'Costa Rica'}];
  const input=[...Array.from({length:10},(_,i)=>audit(i,'Panamá')),audit(11,'Costa Rica')];
  const original=JSON.stringify(input);
  const result=Distributor.distribute(input,validators,options);
  assert.equal(JSON.stringify(input),original);
  assert.deepEqual(Array.from(result,a=>a.id),input.map(a=>a.id));
  assert.equal(result.filter(a=>a.assignedValidatorId==='panama').length,10);
  assert.equal(result[10].assignedValidatorId,'cr');
});

test('sin destino para un país queda sin asignar, nunca conserva una asignación incompatible', () => {
  const result=Distributor.distribute([{...audit(1,'Costa Rica'),assignedValidatorId:'pa'},audit(2,'')],[{id:'pa',smartCountry:'Panamá'}],options);
  assert.equal(result[0].assignedValidatorId,null);
  assert.equal(result[1].assignedValidatorId,null);
});

test('Todos los países y variantes de mayúsculas/tildes funcionan con balanceo', () => {
  const result=Distributor.distribute([audit(1,'PANAMA'),audit(2,'Panamá'),audit(3,'Costa Rica'),audit(4,'Costa Rica')],
    [{id:'pa',smartCountry:'Panamá'},{id:'all',smartCountry:''}],options);
  assert.ok(result.filter(a=>a.pais==='Costa Rica').every(a=>a.assignedValidatorId==='all'));
  assert.equal(result.filter(a=>a.assignedValidatorId==='pa').length,2);
});

test('Bloqueantes ignora restricciones Smart y los validadores del mismo país reciben balance equitativo', () => {
  const input=Array.from({length:9},(_,i)=>audit(i,'Panamá'));
  const validators=[{id:'A',smartCountry:'Panamá'},{id:'B',smartCountry:'Panamá'}];
  const counts=Distributor.getValidatorStats(Distributor.distribute(input,validators,options),validators).map(v=>v.totalAssigned);
  assert.equal(Math.abs(counts[0]-counts[1]),1);
  assert.ok(Distributor.distribute([audit(1,'Costa Rica')],validators,{restrictByCountry:false})[0].assignedValidatorId);
});

test('encabezado de país tiene prioridad sobre F y puede estar en cualquier columna, incluso la primera', () => {
  const rows=[['País del PDV','ID_de_audito','ID_de_PDV','Estado','canal','nombre_usuario','Alerta precio'],
    ['panama','7001','9001','Alerta','MODERNO','ana','Revisar']];
  const result=ExcelParser.transformRowsToObjects(rows);
  assert.equal(result.audits[0].id,'7001');
  assert.equal(result.audits[0].pais,'Panamá');
  const blocking=ExcelParser.transformRowsToObjects([
    ['ID_AUDITO','ID_PDV','ID_PAIS','ESTUDIO','ID_SUBKPI','Nombre del país'],
    ['7002','9002','1097','FEMSA','NOTA PDV','COSTA RICA']]);
  assert.equal(blocking.audits[0].pais,'Costa Rica');
});

test('Perú para Lindley y Chile para Chile sobreviven guardado y lectura; KO preserva país real', () => {
  for (const [estudio,pais] of [['Lindley','Perú'],['Chile','Chile'],['Moderno','Panamá'],['Tradicional','Panamá']]) {
    const row=context.auditToRow({...audit(1,'Panamá'),estudio},'smart',null);
    assert.equal(row.payload.pais,pais);
    const restored=context.mapAudit(JSON.parse(JSON.stringify(row)));
    assert.equal(restored.pais,pais);
  }
});

test('métricas toman país real desde octubre y mantienen oculto el histórico anterior', () => {
  const app=Object.create(App.prototype);
  for (const [estudio,pais] of [['Lindley','Perú'],['Chile','Chile'],['Moderno','Panamá']]) {
    assert.equal(app.getReportCountry({...audit(1,'Panamá'),estudio,_batchOperationDate:'2026-10-05'}),pais);
    assert.equal(app.getReportCountry({...audit(1,'Panamá'),estudio,_batchOperationDate:'2026-09-30'}),'');
  }
  app.currentModule='blocking'; app.currentProject='Moderno';
  assert.equal(app.getDistributionOptions().restrictByCountry,false);
  app.currentModule='smart';
  assert.equal(app.getDistributionOptions().restrictByCountry,true);
});

test('guardar país manda alcance del estudio y actividad al RPC, y lee la configuración persistida', async () => {
  let call;
  const backend=Object.assign(Object.create(SupabaseBackend.prototype),{configured:true,currentScope:{study:{id:'s'},country:{id:'global'}},
    client:{rpc:async(name,args)=>{call={name,args};return {error:null};}}});
  backend.loadScopeValidators=async()=>[{id:'v',smartCountry:'Panamá',isActive:true}];
  const result=await backend.setValidatorSmartCountry('v','Panamá',true);
  assert.equal(result.smartCountry,'Panamá');
  assert.equal(call.name,'set_study_validator_smart_country');
  assert.deepEqual(JSON.parse(JSON.stringify(call.args)),{p_validator_id:'v',p_study_id:'s',p_country_id:'global',p_smart_country:'Panamá',p_active:true});
  backend.client.rpc=async()=>({error:Error('Fuera de alcance')});
  await assert.rejects(backend.setValidatorSmartCountry('v','Panamá'),/Fuera de alcance/);
});

test('reparto manual Smart usa RPC por país; Bloqueantes conserva su RPC', async () => {
  const calls=[];
  const backend=Object.assign(Object.create(SupabaseBackend.prototype),{configured:true,currentScope:{study:{id:'s'}},
    client:{rpc:async(name)=>{calls.push(name);return {data:{reassigned_count:1},error:null};}}});
  for (const module of ['smart','blocking']) await backend.reassignPendingAudits({sourceValidatorId:'a',targetValidatorIds:['b'],module});
  assert.deepEqual(calls,['reassign_smart_pending_by_country','reassign_pending_audits']);
});

test('tarjeta muestra países pequeños debajo del nombre, sin desplegable, y conteos reales en la ayuda', () => {
  const grid={innerHTML:'',querySelectorAll:()=>[]};
  context.document.getElementById=id=>id==='admin-validators-grid'?grid:null;
  const app=Object.assign(Object.create(App.prototype),{currentProject:'Moderno',currentModule:'smart',isSupervisor:true,
    validators:[{id:'v1',code:'VAL-1',name:'Ejemplo',estudio:'Moderno',smartCountry:'Panamá',isActive:true},
      {id:'v2',code:'VAL-2',name:'Sin casos',estudio:'Moderno',smartCountry:'Honduras',isActive:false}],
    getAuditsForCurrentProject:()=>[
      {...audit(1,'Panamá'),assignedValidatorId:'v1'},
      {...audit(2,'Panamá'),assignedValidatorId:'v1',validationStatus:'completada'},
      {...audit(3,'Costa Rica'),assignedValidatorId:'otro'}]});
  app.renderValidatorCards();
  assert.match(grid.innerHTML,/<h4 class="val-name">Ejemplo<\/h4>\s*<small class="val-assigned-countries"[^>]*>🌎 Países asignados: Panamá<\/small>/);
  assert.match(grid.innerHTML,/title="Panamá: 2 auditorías \(1 completadas\)"/);
  assert.match(grid.innerHTML,/title="Sin auditorías asignadas en esta base">🌎 Países asignados: Honduras/);
  assert.doesNotMatch(grid.innerHTML,/<details|Ver países asignados|<summary/);
  assert.match(grid.innerHTML,/btn-delete-validator[^>]*data-id="v1"/);
  app.currentModule='blocking';
  app.renderValidatorCards();
  assert.doesNotMatch(grid.innerHTML,/val-assigned-countries/);
});

test('eliminar exige confirmación, conserva auditorías y bloquea trabajo sin terminar de ambos módulos', async () => {
  let calls=0, confirmed=0;
  const completed={...audit(1,'Panamá'),estudio:'Moderno',assignedValidatorId:'v',validationStatus:'completada'};
  const app=Object.assign(Object.create(App.prototype),{currentProject:'Moderno',isSupervisor:true,
    validators:[{id:'v',name:'Ejemplo',estudio:'Moderno'}],audits:[completed],smartAudits:[completed],blockingAudits:[],
    backend:{configured:true,deleteValidator:async()=>{calls++;}},saveState(){},renderAdminView(){},renderAlertsView(){},
    showToast(){},isExpiredPendingAudit:()=>false});
  context.confirm=()=>{confirmed++;return false;};
  await app.deleteValidator('v');
  assert.equal(calls,0); assert.equal(app.validators.length,1);
  app.blockingAudits=[{...completed,id:'2',validationStatus:'pendiente'}];
  context.confirm=()=>{confirmed++;return true;};
  await app.deleteValidator('v');
  assert.equal(calls,0);assert.equal(confirmed,1);
  app.blockingAudits=[];
  app.backend.deleteValidator=async()=>{throw Error('Offline');};
  await app.deleteValidator('v');
  assert.equal(app.validators.length,1);
  app.backend.deleteValidator=async()=>{calls++;};
  await app.deleteValidator('v');
  assert.equal(calls,1);assert.equal(app.validators.length,0);assert.equal(app.audits[0],completed);
});

test('un validador recibe varios países, y jamás recibe uno fuera de su lista', () => {
  const input=[audit(1,'Panamá'),audit(2,'Costa Rica'),audit(3,'Guatemala'),audit(4,'panama')];
  const result=Distributor.distribute(input,[{id:'multi',smartCountries:['Panamá','Costa Rica']}],options);
  assert.deepEqual(Array.from(result,a=>a.assignedValidatorId),['multi','multi',null,'multi']);
  assert.equal(Distributor.canAssignCountry(audit(1,'Panamá'),{smartCountry:'Guatemala',smartCountries:[]},options),true);
});

test('reparto multipaís conserva el orden y balancea destinos compatibles', () => {
  const input=Array.from({length:14},(_,i)=>audit(i,i%2?'Panamá':'Costa Rica'));
  const result=Distributor.distribute(input,[{id:'a',smartCountries:['Panamá','Costa Rica']},{id:'b',smartCountries:['Costa Rica','Panamá']}],options);
  assert.deepEqual(Array.from(result,a=>a.id),input.map(a=>a.id));
  assert.equal(result.filter(a=>a.assignedValidatorId==='a').length,7);
  assert.equal(result.filter(a=>a.assignedValidatorId==='b').length,7);
});

test('guardar lista usa RPC multipaís y lee el arreglo persistido del estudio', async () => {
  const backend=Object.create(SupabaseBackend.prototype);
  let sent;
  backend.ensureConfigured=()=>{};
  backend.currentScope={study:{id:'study-1'},country:{id:'scope-1'}};
  backend.client={rpc:async(name,args)=>{sent={name,args};return{error:null};}};
  backend.loadScopeValidators=async()=>[{id:'v',smartCountries:['Costa Rica','Panamá']}];
  const restored=await backend.setValidatorSmartCountries('v',['Costa Rica','Panamá'],true);
  assert.equal(sent.name,'set_study_validator_smart_countries');
  assert.deepEqual(Array.from(sent.args.p_smart_countries),['Costa Rica','Panamá']);
  assert.equal(sent.args.p_active,true);
  assert.deepEqual(Array.from(restored.smartCountries),['Costa Rica','Panamá']);
});

test('lector de casillas distingue varios países, todos y selección vacía inválida', () => {
  const app=Object.create(App.prototype);
  const all={checked:false};
  let values=[{value:'PANAMA'},{value:'Costa Rica'}];
  const card={querySelector:()=>all,querySelectorAll:()=>values};
  assert.deepEqual(Array.from(app.readValidatorSmartCountries(card,{})),['Panamá','Costa Rica']);
  all.checked=true;
  assert.deepEqual(Array.from(app.readValidatorSmartCountries(card,{})),[]);
  all.checked=false;values=[];
  assert.throws(()=>app.readValidatorSmartCountries(card,{}),/Selecciona al menos un país/);
});
