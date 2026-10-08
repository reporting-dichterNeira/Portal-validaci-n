// Isolated browser fixture: synthetic data only, no Supabase credentials/writes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const backend = `
const counts = {};
function count(key) { counts[key] = (counts[key] || 0) + 1; console.info('Fixture calls: ' + JSON.stringify(counts)); }
const audits = Array.from({length:2001}, (_, i) => ({ id:String(i+1), _rowId:i+1, _batchId:'fixture',
 _module:'blocking', estudio:'Moderno', pais:'Panamá', idPDV:String(90000+i), fecha:'2026-10-08', _batchOperationDate:'2026-10-08',
 assignedValidatorId:'fixture-validator', _validatorName:'Validador de prueba', _validatorCode:'VAL-FIXTURE',
 validationStatus:'completada', durationSeconds:10, completedAt:'2026-10-08T10:00:00Z',
 kpis:[{name:'KPI de prueba',needsReview:true}], validationResults:{'KPI de prueba':{status:i%2?'aplica':'no_aplica',tipificacion:'Prueba'}} }));
const imports = ['alerts','editions'].map(dataset_type=>({dataset_type,period_month:'2026-10-01',source_filename:'Prueba aislada.csv',row_count:2001,imported_at:'2026-10-08'}));
export class SupabaseBackend {
 configured=true;
 async getSessionContext(){return {role:'visualizer',profile:{id:'fixture',display_name:'Prueba aislada'},assignments:[],scope:null};}
 async loadState(){count('active');return {validators:[{id:'fixture-validator',name:'Validador de prueba',code:'VAL-FIXTURE',estudio:'Moderno'}],smartAudits:[],blockingAudits:audits.slice(0,1)};}
 subscribe(){} unsubscribe(){}
 async loadAdministration(){count('daily');return {studies:[],supervisors:[],assignments:[],validators:[],batches:[],audits:[],batchCreators:[],batchUploaders:[],operationDate:'2026-10-08'};}
 async loadAdminAnalysisImports(){count('imports');return imports;}
 async loadAdminExternalAnalysis({includeAlerts=true,includeEdits=true}={}){
  if(includeAlerts)count('alerts');if(includeEdits)count('editions');
  return {imports,alertRecords:includeAlerts?audits.map(a=>({audit_external_id:a.id,period_month:'2026-10-01',country:a.pais,study:'ko_moderno_pa_202610',auditor:'Auditor de prueba',audit_date:'2026-10-08'})):[],
   editRecords:includeEdits?audits.map(a=>({audit_external_id:a.id,period_month:'2026-10-01',modifications_count:2})):[]};
 }
 async loadAuditHistory({module}={}){count('history');return module==='smart'?[]:audits;}
 async loadAdminNoteScoreImports(){count('noteImports');return ['2026-09-01','2026-08-01'].map(period_month=>({period_month,row_count:1,source_filename:'Notas de prueba.csv',imported_at:'2026-10-08'}));}
 async loadAdminNoteScoreAnalysis({periodMonth}={}){count('notes-'+periodMonth);return {noteScoreImports:await this.loadAdminNoteScoreImports(),noteScoreRecords:[{audit_external_id:'1',pdv_id:'90000',period_month:periodMonth,study:'Moderno',subkpi:'KPI de prueba',score:0.8,previous_total_score:0.7,current_total_score:periodMonth==='2026-08-01'?0.6:0.8,previous_subkpi_score:0.7,current_subkpi_score:0.8}]};}
 async loadAuditCountryContext(){return [];}
 async getDatabricksSyncStatus(){return null;}
 async loadValidatorHistory(){throw new Error('Fixture forbids historical RPC');}
}
`;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/js/supabase-backend.js') { res.setHeader('Content-Type','text/javascript; charset=utf-8'); res.end(backend); return; }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp'}[path.extname(file)] || 'application/octet-stream';
  res.setHeader('Content-Type', type + (type.startsWith('text/')?'; charset=utf-8':''));
  res.setHeader('Cache-Control','no-store');
  res.end(fs.readFileSync(file));
}).listen(8772,'127.0.0.1',()=>console.log('Isolated visualization fixture: http://127.0.0.1:8772'));
