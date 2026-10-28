const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');

function fixture(){
 const books=[],downloads=[];
 const context=vm.createContext({
  getStudyDisplayName:value=>value,formatNicaraguaDateTime:value=>value||'Pendiente',getNicaraguaDateKey:value=>String(value||'').slice(0,10),
  XLSX:{utils:{book_new:()=>({sheets:{}}),json_to_sheet:rows=>rows,book_append_sheet:(book,rows,name)=>{book.sheets[name]=rows;}},writeFile:(book,name)=>books.push({book,name})},
  Blob:class{constructor(parts){this.text=parts.join('');}},URL:{createObjectURL:blob=>{downloads.push(blob.text);return 'blob:export';},revokeObjectURL(){}},
  document:{body:{appendChild(){}},createElement:()=>({style:{},click(){},remove(){}})},alert:message=>{throw Error(message);}
 });
 const parser=fs.readFileSync(path.join(root,'js/excel-parser.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class ExcelParser','class ExcelParser');
 const backend=fs.readFileSync(path.join(root,'js/supabase-backend.js'),'utf8');
 const mapper=backend.slice(backend.indexOf('function mapAudit('),backend.indexOf('function auditToRow('));
 vm.runInContext(`${mapper}\n${parser}\nthis.ExcelParser=ExcelParser;this.mapAudit=mapAudit;`,context);
 const audit=context.mapAudit({id:10,external_id:'5719839',study:'Lindley',module:'blocking',assigned_validator_id:'historical-validator',
  validator_name:'Validador histórico Lindley',validator_code:'VAL-HIST-TEST',status:'completada',batch_operation_date:'2026-10-19',
  started_at:'2026-10-19T18:00:00Z',completed_at:'2026-10-20T18:03:00Z',validation_results:{Precio:{status:'no_aplica'}},
  payload:{idPDV:'7766913',kpis:[{name:'Precio',needsReview:true}]}});
 return {ExcelParser:context.ExcelParser,books,downloads,audit,mapAudit:context.mapAudit};
}
test('historical validator returned by the backend survives daily, consolidated, multi-sheet, CSV and executive exports without a current roster entry',()=>{
 const {ExcelParser:P,books,downloads,audit}=fixture();
 const before=JSON.stringify(audit),roster=[{id:'another-validator',name:'Otra persona',code:'VAL-OTHER'}];
 P.exportSingleDayExcel([audit],roster,'2026-10-19');
 P.exportResultsToExcel([audit],roster);
 P.exportDailyAndConsolidatedExcel([audit],roster);
 P.exportResultsToCsv([audit],roster);
 P.exportExecutiveExcel([audit],'Lindley');
 for(const [bookIndex,sheet,label] of [[0,'Auditorias_2026-10-19','Validador Responsable'],[1,'Auditorias_Validadas','Validador Asignado'],[2,'Consolidado_General','Validador Asignado'],[2,'Dia_2026-10-20','Validador Asignado'],[3,'Trazabilidad_Tiempos','Validador']]){
  const [row]=books[bookIndex].book.sheets[sheet];assert.equal(row[label],'Validador histórico Lindley',sheet);
  assert.equal(row['Código Validador']??row['Código validador'],'VAL-HIST-TEST',sheet);
 }
 const summary=books[1].book.sheets.Resumen_Validadores.find(row=>row['Código']==='VAL-HIST-TEST');
 assert.equal(summary.Nombre,'Validador histórico Lindley');assert.equal(summary['Total Asignadas'],1);assert.equal(summary.Completadas,1);
 assert.match(downloads[0],/Validador histórico Lindley/);assert.match(downloads[0],/VAL-HIST-TEST/);
 assert.equal(JSON.stringify(audit),before);assert.equal(roster.length,1);
});
test('current roster matches by identity and each missing field falls back to historical data',()=>{
 const {ExcelParser:P,audit,mapAudit}=fixture();
 let [row]=P.buildConsolidatedExportRows([audit],[{id:audit.assignedValidatorId,name:'Nombre actual',code:''}]);
 assert.equal(row['Validador Asignado'],'Nombre actual');assert.equal(row['Código Validador'],'VAL-HIST-TEST');
 [row]=P.buildConsolidatedExportRows([audit],[{id:audit.assignedValidatorId,name:'',code:'VAL-CURRENT'}]);
 assert.equal(row['Validador Asignado'],'Validador histórico Lindley');assert.equal(row['Código Validador'],'VAL-CURRENT');
 const joined=mapAudit({external_id:'2',assigned_validator_id:'joined',validators:[{name:'Validador del registro',code:'VAL-JOINED'}],payload:{kpis:[]}});
 [row]=P.buildConsolidatedExportRows([joined],[]);assert.equal(row['Validador Asignado'],'Validador del registro');assert.equal(row['Código Validador'],'VAL-JOINED');
 [row]=P.buildConsolidatedExportRows([{id:'numeric',assignedValidatorId:42,kpis:[]}],[{id:'42',name:'Identidad 42',code:'VAL-42'}]);
 assert.equal(row['Validador Asignado'],'Identidad 42');assert.equal(row['Código Validador'],'VAL-42');
});
test('missing metadata never becomes another validator or an ID used as an access code',()=>{
 const {ExcelParser:P}=fixture();
 const rows=P.buildConsolidatedExportRows([{id:'1',kpis:[]},{id:'2',assignedValidatorId:'not-in-roster',kpis:[]},{id:'3',_validatorCode:'VAL-CODE-ONLY',kpis:[]}],
  [{id:'unrelated',name:'Otra persona',code:'VAL-OTHER'}]);
 assert.equal(rows[0]['Validador Asignado'],'Sin asignar');assert.equal(rows[0]['Código Validador'],'');
 assert.equal(rows[1]['Validador Asignado'],'Validador sin identificar');assert.equal(rows[1]['Código Validador'],'');
 assert.equal(rows[2]['Validador Asignado'],'Validador sin identificar');assert.equal(rows[2]['Código Validador'],'VAL-CODE-ONLY');
});
