const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const M=global.PortalIndicatorMetrics,U=require('../js/indicator-dashboard.js');
const ctx=vm.createContext({console,Date,setTimeout,clearTimeout,SUPABASE_CONFIG:{},PortalIndicators:U,PortalIndicatorMetrics:M,
 document:{getElementById:()=>null},getStudyDisplayName:v=>v,formatNicaraguaDate:v=>v,formatNicaraguaDateTime:v=>v});
for(const [file,name] of [['excel-parser.js','ExcelParser'],['supabase-backend.js','SupabaseBackend']]){
 const code=fs.readFileSync(require.resolve('../js/'+file),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class','class');
 vm.runInContext(code+'\nthis.'+name+'='+name+';',ctx);
}
const appCode=fs.readFileSync(require.resolve('../js/app.js'),'utf8');
vm.runInContext(appCode.slice(0,appCode.indexOf('// Inicializar la aplicación inmediatamente')).replace(/^import .*;\r?\n/gm,'')+'\nthis.App=ValidaFlowApp;',ctx);
const audit=(id,extra={})=>({id,estudio:'Chile',_module:'blocking',fecha:'2026-10-11',fechaAuditoriaOriginal:'2026-10-07',pais:'Chile',canal:'GROCERY SHOPPING',region:'Sin región',
 kpis:[{name:'A',needsReview:true}],validationResults:{A:{status:'aplica'}},...extra});
const context=(id,region)=>({audit_external_id:id,study:'ko_trad_ch_202610',country:'Chile',region,channel:'HOME MARKET TRADICIONAL',segmento:'BRONCE'});
test('reported Chile IDs export their actual Databricks region and channel, ignoring upload placeholders',()=>{
 const rows=[audit('5692890'),audit('5695658'),audit('5695983')],before=JSON.stringify(rows);
 const data=U.alertExport(rows,[context('5692890','TEMUCO'),context('5695658','PUERTO MONTT'),context('5695983','VIÑA DEL MAR')]);
 assert.deepEqual(data.rows.map(r=>[r[1],r[data.headers.indexOf('Región')],r[data.headers.indexOf('Canal')]]),[['5692890','TEMUCO','HOME MARKET TRADICIONAL'],['5695658','PUERTO MONTT','HOME MARKET TRADICIONAL'],['5695983','VIÑA DEL MAR','HOME MARKET TRADICIONAL']]);
 assert.equal(JSON.stringify(rows),before);
});
test('ID plus study rejects unrelated matches; equivalent casing is one value; genuine ambiguity is explicit',()=>{
 const a=audit('5692890',{databricksGeography:{region:'ANTIGUA'},region:'TALCA'});
 const other={...context('5692890','ARICA'),study:'ko_moderno_cr_202610',channel:'OTRO'};
 assert.equal(U.adapt([a],[context(a.id,'TEMUCO'),other])[0].region,'TEMUCO');
 const same=[context(a.id,'Región Centro'),{...context(a.id,'REGION CENTRO'),channel:'home market tradicional'}];
 assert.equal(U.adapt([a],same)[0].region,'REGION CENTRO');assert.ok(U.adapt([a],same)[0].channel);
 const ambiguous=[context(a.id,'TEMUCO'),context(a.id,'ARICA')];
 assert.equal(U.adapt([a],ambiguous)[0].region,'');assert.equal(U.reportDimensions(a,ambiguous).regionAmbiguous,true);
});
test('commercial resolves only requested metadata through the narrow RPC and caches identity by study',async()=>{
 const rows=[audit('5692890')],requests=[];
 const a=Object.assign(Object.create(ctx.App.prototype),{currentRole:'commercial',currentProfile:{id:'commercial'},currentView:'visualizations',
 benchmarkCountryRows:[],adminExternalAnalysis:{alertRecords:[]},getReportAuditSource:()=>rows,renderReportsView(){},
 backend:{configured:true,async loadAuditCountryContext(){throw new Error('Raw export must not be queried');},async loadAuditReportContext(pairs){requests.push(pairs);return [context('5692890','TEMUCO')];}}});
 assert.equal(a.areReportDimensionsReady(rows),false);
 await Promise.all([a.ensureBenchmarkCountries(rows),a.ensureBenchmarkCountries(rows)]);
 assert.equal(requests.length,1);assert.equal(a.areReportDimensionsReady(rows),true);
 assert.equal(rows[0].canal,'GROCERY SHOPPING');assert.equal(rows[0].databricksGeography.channel,'HOME MARKET TRADICIONAL');
 assert.equal(ctx.ExcelParser.buildConsolidatedExportRows(rows,[])[0].Canal,'HOME MARKET TRADICIONAL');
 assert.equal(ctx.ExcelParser.getGeographyExportFields(rows[0])['Región'],'TEMUCO');
 const other=audit('5692890',{estudio:'Moderno'});assert.equal(a.areReportDimensionsReady([other]),false);
 await a.ensureBenchmarkCountries([other]);assert.equal(requests.length,2);assert.notEqual(other.databricksGeography?.region,'TEMUCO');
});
test('backend requests bounded ID/study batches and retains all scalar JSON response rows',async()=>{
 const backend=Object.create(ctx.SupabaseBackend.prototype),requests=[];
 backend.readMetricsRpc=async(name,args)=>{requests.push({name,args});return args.p_audits.map(a=>({audit_external_id:a.id,study:a.study,region:'TEMUCO'}));};
 const rows=Array.from({length:1001},(_,i)=>({id:String(i+1),study:'Chile'}));
 const result=await backend.loadAuditReportContext([...rows,rows[0],{id:'Filtro',study:'Chile'}]);
 assert.equal(result.length,1001);assert.deepEqual(requests.map(r=>r.args.p_audits.length),[500,500,1]);
 assert.ok(requests.every(r=>r.name==='get_audit_report_context'));
});
test('CSV stays disabled while metadata is unresolved, then becomes available after a fresh render',()=>{
 const wrapper={closest:()=>null,querySelector:()=>({querySelectorAll:s=>s==='thead th'?[{dataset:{exportValue:'Columna'}}]:[{cells:[{dataset:{exportValue:'Valor'}}],querySelector:()=>null}]})};
 const chartButton={closest:()=>wrapper,addEventListener(){},setAttribute(){}},button={addEventListener(){}},target={innerHTML:'',parentElement:{children:[]},querySelectorAll:s=>s==='[data-chart-table-export]'?[chartButton]:[],querySelector:s=>s==='[data-indicator-download]'?button:null};
 global.document={getElementById:id=>id==='indicators-operational'?target:null};
 let ready=false;
 const app={currentView:'visualizations',currentRole:'commercial',reportsSubtab:'metrics',selectedStudies:['Chile'],
  getVisualizationModuleFilter:()=> 'blocking',getReportCountry:()=> 'Chile',areReportDimensionsReady:()=>ready,
  benchmarkCountryRows:[context('5692890','TEMUCO')]};
 try {
  U.render(app,[audit('5692890')]);assert.equal(button.disabled,true);assert.equal(chartButton.disabled,true);assert.match(target.innerHTML,/Contrastando región y canal/);
  ready=true;U.render(app,[audit('5692890')]);assert.equal(button.disabled,false);assert.equal(chartButton.disabled,false);assert.doesNotMatch(target.innerHTML,/Contrastando región y canal/);
 }finally{delete global.document;}
});
