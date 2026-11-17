import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qualityBackend} from '../js/quality-backend.mjs';
import {PqrUI,loginView,dashboardView as pqrDashboard} from '../js/pqr-ui.mjs';
import {dashboardView,detailView,studySettingsView} from '../js/qa-ui.mjs';
const data=role=>({context:{role,name:'Prueba'},day:'2026-11-17',today:'2026-11-17',stats:{eligible:184,target:65,percentage:35,selected:65},analysts:[],reviews:[],study_settings:[]});
test('QA counts and labels are alerts, PQR remains audits',()=>{
 const qa=dashboardView(data('supervisor'),{}),pqr=pqrDashboard(data('supervisor'),{});
 assert.match(qa,/Alertas no válidas en Bloqueantes/);assert.match(qa,/35% de alertas no válidas/);assert.match(qa,/name="qa_percentage"/);
 assert.match(pqr,/Terminadas ese día · IDs únicos/);assert.doesNotMatch(pqr,/name="qa_percentage"/);
 assert.match(studySettingsView(),/value="35"/);
});
test('both staff roles have two sheets; analysts have no operation or management controls',()=>{
 for(const role of ['supervisor','admin']){const ui=new PqrUI({}, {operation:'qa'});const html=ui.renderDashboard(data(role));assert.match(html,/data-operation="pqr"/);assert.match(html,/data-operation="qa"/);assert.match(html,/Operación QA/);}
 const ui=new PqrUI({}, {operation:'qa'}),html=ui.renderDashboard(data('analyst'));
 assert.doesNotMatch(html,/data-operation|pqr-settings|pqr-create-analyst/);assert.match(html,/Mis alertas asignadas/);
 assert.match(loginView('qa'),/placeholder="QA-…"/);assert.doesNotMatch(loginView('qa'),/name="password" autocomplete="current-password" required/);
});
test('QA detail shows immutable original no-valid decision and evaluation',()=>{
 const html=detailView({id:'a',external_id:'123',study:'Chile',day:'2026-11-17',kpis:[{name:'Precio'}],original_results:{Precio:{status:'no_aplica'}},review_results:{}},'analyst');
 assert.match(html,/Alerta no válida · No aplica/);assert.match(html,/value="correct"/);assert.match(html,/value="incorrect"/);
});
const fakeClient=()=>{const calls=[];return {calls,auth:{async getSession(){return {data:{session:{}}}},async signOut(){calls.push(['signOut']);return {}},async signInAnonymously(){return {}},async signInWithPassword(){return {}}},async rpc(name,args){calls.push([name,args]);return {data:{role:'analyst',operation:name.startsWith('qa')?'qa':'pqr'}}}};};
test('sheet switch routes requests without replacing auth or PQR assignments',async()=>{
 const client=fakeClient(),backend=qualityBackend(client,null);await backend.call('dashboard');backend.setOperation('qa');await backend.call('dashboard');backend.setOperation('pqr');await backend.call('context');
 assert.deepEqual(client.calls.map(c=>c[0]),['pqr_api','qa_api','pqr_api']);
});
test('QA and PQR analyst credentials use their separate endpoints',async()=>{
 const client=fakeClient(),backend=qualityBackend(client,null);await backend.login('qa',{code:'QA-ABCDEFGH2345'});
 assert.equal(backend.operation,'qa');assert.equal(client.calls.at(-1)[0],'qa_login');assert.equal(client.calls.at(-1)[1].p_kind,'analyst');
 await backend.login('analyst',{code:'PQR-ABCDEFGH2345'});assert.equal(backend.operation,'pqr');assert.equal(client.calls.at(-1)[0],'pqr_login');
});
