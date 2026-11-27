import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preferLindleyTraditional as clean} from '../js/lindley-models.mjs';
const k=(base,model,name=base)=>({name,kpiName:base,modelo:model,needsReview:true});
const fixture=()=>({id:'5771794',estudio:'Lindley',_module:'blocking',kpis:[k('Lleno al 75%','PORTAFOLIO'),k('Primera Posición','TRADICIONAL'),k('Primera Posición','PORTAFOLIO','Primera Posición (PORTAFOLIO)'),k('Lleno al 75%','TRADICIONAL','Lleno al 75% (TRADICIONAL)'),k('Sin Contaminar','TITÁN')],validationResults:{'Lleno al 75%':{status:'no_aplica'},'Lleno al 75% (TRADICIONAL)':{status:'aplica'},'Primera Posición':{status:'aplica'},'Primera Posición (PORTAFOLIO)':{status:'no_aplica'}}});
test('Lindley retains explicit traditional model independent of row order and keeps unique models',()=>{
 const original=fixture(),before=JSON.stringify(original),result=clean(original);
 assert.deepEqual(result.kpis.map(k=>k.name),['Primera Posición','Lleno al 75% (TRADICIONAL)','Sin Contaminar']);
 assert.equal(result.validationResults['Lleno al 75% (TRADICIONAL)'].status,'aplica');assert.equal(result.validationResults['Lleno al 75%'],undefined);
 assert.equal(result._lindleyModelDuplicates.length,2);assert.equal(result._lindleyModelDuplicates[0].validationResult.status,'no_aplica');
 assert.equal(JSON.stringify(original),before);assert.deepEqual(clean(result),result);
 assert.deepEqual(clean({...original,kpis:[...original.kpis].reverse()}).kpis.map(k=>k.name).sort(),result.kpis.map(k=>k.name).sort());
});
test('no traditional counterpart, other studies and Smart remain unchanged',()=>{
 for(const a of [{...fixture(),estudio:'Chile'},{...fixture(),_module:'smart'},{...fixture(),kpis:[k('K','PORTAFOLIO'),k('K','TITÁN','K (TITÁN)')]}])assert.equal(clean(a),a);
});
test('comparison handles spacing and accents, never combines different sub-KPIs',()=>{
 const a={...fixture(),kpis:[k(' Primera  Posición ','Portafolio'),k('primera posicion',' Tradicional ','primera posicion (Tradicional)'),k('Otra','Portafolio')]};
 assert.deepEqual(clean(a).kpis.map(k=>k.name),['primera posicion (Tradicional)','Otra']);
});


test('real parser, scoped upload and backend historical mapping all keep the traditional row',async()=>{
 const fs=await import('node:fs'),vm=await import('node:vm');const context=vm.createContext({preferLindleyTraditional:clean,SUPABASE_CONFIG:{},getStudyDisplayName:v=>v});
 const source=fs.readFileSync(new URL('../js/excel-parser.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class ExcelParser','class ExcelParser');
 vm.runInContext(source+'\nthis.Parser=ExcelParser;',context);
 const parsed=context.Parser.transformRowsToObjects([['ID_AUDITO','ID_PDV','PAIS','modelo_name','KPI_SUBKPI'],['5771794','1031154','Perú','PORTAFOLIO','Primera Posición'],['5771794','1031154','Perú','TRADICIONAL','Primera Posición']]);
 assert.equal(parsed.audits[0].kpis.length,2);
 const backend=fs.readFileSync(new URL('../js/supabase-backend.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class');vm.runInContext(backend,context);
 const audit={...parsed.audits[0],estudio:'Lindley',_module:'blocking'};context.audit=audit;
 const row=vm.runInContext("auditToRow(audit,'blocking',{study:{name:'Lindley'}})",context);
 assert.equal(row.payload.kpis.length,1);assert.equal(row.payload.kpis[0].modelo,'TRADICIONAL');
 context.row={module:'blocking',study:'Lindley',external_id:'5771794',payload:audit,validation_results:{}};
 const historical=vm.runInContext('mapAudit(row)',context);assert.equal(historical.kpis.length,1);assert.equal(historical.kpis[0].modelo,'TRADICIONAL');
 context.row.study='Chile';assert.equal(vm.runInContext('mapAudit(row)',context).kpis.length,2);
});
