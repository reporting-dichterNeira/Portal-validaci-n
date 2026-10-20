// Prueba de UI aislada: datos ficticios, almacenamiento en memoria, sin Supabase.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const allowed=new Set(['/css/styles.css','/js/validator-ui.js','/js/time-utils.js','/js/study-labels.js','/js/sample-data.js','/assets/dn-logo-color.png']);
const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prueba aislada · Validación Smart</title><link rel="stylesheet" href="/css/styles.css"><style>.test-wrap{max-width:1000px;margin:25px auto;padding:0 20px}.test-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px}#test-saved{white-space:pre-wrap;font-size:12px;background:#eef7ff;padding:14px;border-radius:10px;margin-top:18px}</style></head><body>
<header class="app-header"><div class="header-container"><div class="brand-logo"><img class="header-dn-logo" src="/assets/dn-logo-color.png" alt="dichter & neira"><span class="logo-title">ValidaFlow</span></div><span class="badge badge-info">Prueba local · Sin datos reales</span></div></header>
<main class="test-wrap"><div class="test-toolbar"><h1 id="test-title">Validación Smart</h1><button class="btn btn-outline btn-sm" id="test-smart">Smart</button><button class="btn btn-outline btn-sm" id="test-blocking">Bloqueantes</button><button class="btn btn-outline btn-sm" id="test-reopen">Reabrir lo guardado</button></div><p>Verificación del formulario real con auditorías de prueba. No guarda en producción.</p><div id="val-audit-detail"></div><output id="test-message" role="status"></output><pre id="test-saved" aria-label="Resultado guardado">Todavía no se ha guardado.</pre></main>
<script type="module">
import {ValidatorUI} from '/js/validator-ui.js';
import {TIPIFICACIONES_POR_DECISION} from '/js/sample-data.js';
const date=new Date().toISOString();
const makeAudit=module=>({id:module==='smart'?'999001':'999002',_module:module,assignedValidatorId:'test-validator',estudio:'Moderno',pais:'Panamá',idPDV:'9999001',ciudad:'Ciudad de Panamá',canal:'MODERNO',fecha:date.slice(0,10),startedAt:date,validationStatus:'en_progreso',validationResults:{},kpis:[{name:'Alerta precio',originalValue:'Revisar',needsReview:true},{name:'Alerta portafolio',originalValue:'Revisar',needsReview:true}]});
const audits={smart:makeAudit('smart'),blocking:makeAudit('blocking')};let module='smart';
const app={smartAudits:[audits.smart],blockingAudits:[audits.blocking],getTipificacionesForDecision:decision=>[...TIPIFICACIONES_POR_DECISION[decision]],saveState(){},isExpiredPendingAudit:()=>false,showToast(message){document.getElementById('test-message').textContent=message;},syncStateAcrossTabs:async({audit,module})=>{
const response=await fetch('/test-progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audit,module})});if(!response.ok)throw new Error('No se guardó la prueba');const saved=await response.json();document.getElementById('test-saved').textContent=JSON.stringify({module,status:saved.validationStatus,validationResults:saved.validationResults},null,2);return saved;}};
const ui=new ValidatorUI(app);ui.currentValidator={id:'test-validator'};ui.currentModule=module;ui.currentAuditId=audits[module].id;
ui.renderAuditList=ui.updateProgressHeader=()=>{};ui.loadProductivity=async()=>{};ui.getMyAudits=()=>[audits[module]];ui.selectAudit=()=>{ui.currentAuditNeedsSave=false;ui.renderAuditDetail(audits[module]);};
function show(next){module=next;ui.currentModule=module;ui.currentAuditId=audits[module].id;ui.currentAuditNeedsSave=true;document.getElementById('test-title').textContent=module==='smart'?'Validación Smart':'Alertas Bloqueantes';ui.renderAuditDetail(audits[module]);}
document.getElementById('test-smart').addEventListener('click',()=>show('smart'));document.getElementById('test-blocking').addEventListener('click',()=>show('blocking'));
document.getElementById('test-reopen').addEventListener('click',async()=>{const response=await fetch('/test-progress?module='+module);const saved=await response.json();if(saved){Object.assign(audits[module],saved);show(module);document.getElementById('test-message').textContent='Auditoría guardada reabierta desde el servidor local.';}});
show('smart');
</script></body></html>`;
const saved=new Map();
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/test-progress'){
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(req.method==='GET'){res.end(JSON.stringify(saved.get(url.searchParams.get('module'))||null));return;}
    if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
    let body='';req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy();});req.on('end',()=>{try{const data=JSON.parse(body);if(!['smart','blocking'].includes(data.module)||!['999001','999002'].includes(data.audit?.id))throw Error('Solo fixtures');saved.set(data.module,data.audit);console.log('Fixture guardada:',data.module,data.audit.validationStatus);res.end(JSON.stringify(data.audit));}catch{res.writeHead(400);res.end('{}');}});return;
  }
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  if(!allowed.has(url.pathname)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.png')?'image/png':'text/javascript');res.end(fs.readFileSync(path.join(root,url.pathname.slice(1))));
}).listen(8775,'127.0.0.1',()=>console.log('Prueba Smart aislada: http://127.0.0.1:8775/'));
