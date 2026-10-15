// Local visual QA using synthetic data and the real chart renderer. No remote data.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Métricas visuales · Prueba</title><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/css/indicators.css"><style>body{overflow:auto}.preview{max-width:1400px;margin:24px auto;padding:0 24px}.preview-toolbar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:20px 0}.preview-toolbar label{display:flex;gap:8px;align-items:center}.preview-toolbar select{padding:8px}.preview h1{font-size:22px}</style></head><body><div class="preview"><h1>Métricas visuales · Datos de prueba</h1><div class="preview-toolbar"><label>Módulo<select id="preview-module"><option value="all">Consolidado</option><option value="blocking">Bloqueantes</option><option value="smart">Smart</option></select></label><button id="preview-theme" class="btn btn-outline btn-sm">Cambiar tema</button></div><main><div id="indicators-operational"></div></main></div><script src="/js/indicator-metrics.js"></script><script src="/js/indicator-dashboard.js"></script><script type="module">
import "/js/study-labels.js?v=1.1";
const studies=['Chile','Tradicional','Moderno','Lindley'],months=['2026-08','2026-09','2026-10'];
const audits=Array.from({length:240},(_,i)=>{
 const module=i%5===0?'smart':'blocking',study=studies[i%4],month=months[Math.floor(i/80)],day=month+'-08';
 const country=study==='Chile'?'Chile':study==='Lindley'?'Perú':i%3?'Panamá':'Costa Rica';
 const kpis=['Precio','Disponibilidad','Exhibición','Portafolio'].slice(0,1+i%4).map(name=>({name,needsReview:true}));
 const validationResults=Object.fromEntries(kpis.filter((k,j)=>month!=='2026-10'||(i+j)%4).map((k,j)=>[k.name,{status:(i+j)%3?'aplica':'no_aplica',tipificacion:['Evidencia correcta','Fuera de alcance','Sin tipificación'][i%3],decisionAt:day+'T16:00:00Z'}]));
 return {id:String(i+1),_module:module,_batchId:1,estudio:study,pais:country,fecha:day,fechaAuditoriaOriginal:month+'-01',_batchUploadedAt:day+'T12:00:00Z',
  canal:i%2?'Tradicional':'Moderno',subcanal:i%3?'Supermercado':'Tienda',region:study==='Chile'?'Norte':study==='Lindley'?'Lima':'',
  databricksGeography:{segmento:['A','B','C'][i%3],auditor:'Auditor '+(i%6+1),auditorSource:'storeview.slv_sv_ceres_ag_export.nombre_usuario'},kpis,validationResults};
});
const app={currentView:'visualizations',currentProfile:{id:'preview'},reportsSubtab:'metrics',indicatorOperationalSection:'evolution',selectedMetricsMonth:'2026-10',selectedStudies:['ALL'],selectedReportCountry:'all',
 visualizationDateFrom:'2026-08-01',visualizationDateTo:'2026-10-13',indicatorFilters:{region:'all',channel:'all',subchannel:'all',month:'2026-10'},
 getVisualizationModuleFilter:()=>document.getElementById('preview-module').value,getReportCountry:a=>a.pais,
 getMetricsScopeOptions:()=>({months:months.map(value=>({value,label:value})),studies:studies.map(value=>({value,label:{Tradicional:'KO Tradicional CAM',Moderno:'KO Moderno CAM'}[value]||value})),countries:['Chile','Costa Rica','Panamá','Perú'].map(value=>({value,label:value}))}),
 setMetricsScopeFilter(key,value){
  if(key==='module')document.getElementById('preview-module').value=value;
  else if(key==='study')this.selectedStudies=value==='all'?['ALL']:[value];
  else if(key==='country')this.selectedMetricsCountry=value;
  else if(key==='month')this.selectedMetricsMonth=value;
  else if(key==='from')this.visualizationDateFrom=value;
  else if(key==='to')this.visualizationDateTo=value;
  else if(key==='dates-clear'){this.visualizationDateFrom='';this.visualizationDateTo='';}
  this.renderReportsView();},
 backend:{loadDatabricksAuditTotals:async(filters)=>{
  const inputs=PortalIndicators.adapt(audits,[],a=>a.pais,'all').filter(a=>(!filters.studies.length||filters.studies.includes(a.study))&&(!filters.month||a.month===filters.month));
  const filtered=PortalIndicatorMetrics.compute(inputs,{...filters,asOf:'2026-10-15'}).alerts;
  const auditorIds=new Map(),territoryIds=new Map(),segmentIds=new Map();
  for(const a of filtered){if(!auditorIds.has(a.auditor))auditorIds.set(a.auditor,new Set());auditorIds.get(a.auditor).add(a.study+':'+a.id);
   const key=JSON.stringify([a.study,a.geography]);if(!territoryIds.has(key))territoryIds.set(key,new Set());territoryIds.get(key).add(a.id);
   const segmentKey=JSON.stringify([a.study,a.channel,a.segment]);if(!segmentIds.has(segmentKey))segmentIds.set(segmentKey,new Set());segmentIds.get(segmentKey).add(a.id);}
  return {studies:['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley'].map(study_name=>({study_name,databricks_total:1200})),
   territory_totals_ready:true,territories:[...territoryIds].map(([key,ids])=>{const [study_name,geography]=JSON.parse(key);return {study_name,geography,databricks_total:ids.size*3};}),
   auditor_totals_ready:!!filters.include_auditors,auditors:filters.include_auditors?[...auditorIds].map(([auditor,ids])=>({auditor,databricks_total:ids.size*3})).concat([{auditor:'Auditor sin alertas',databricks_total:25}]):[],
   channel_segment_totals_ready:!!filters.include_channel_segments,channel_segments:filters.include_channel_segments?[...segmentIds].map(([key,ids])=>{const [study_name,channel,segmento]=JSON.parse(key);return {study_name,channel,segmento,databricks_total:ids.size*3};}):[],
   snapshots:[{month:'2026-10-01',source:'Databricks · Prueba local',refreshed_at:'2026-10-13'}]};
 }},
 renderReportsView(){const module=this.getVisualizationModuleFilter(),scoped=audits.filter(a=>(this.selectedStudies.includes('ALL')||this.selectedStudies.includes(a.estudio))&&(!this.selectedMetricsCountry||this.selectedMetricsCountry==='all'||a.pais===this.selectedMetricsCountry));PortalIndicators.render(this,scoped.filter(a=>module==='all'||a._module===module),scoped,null,scoped);}};

document.getElementById('preview-module').onchange=()=>app.renderReportsView();
document.getElementById('preview-theme').onclick=()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
app.renderReportsView();
</script></body></html>`;
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 res.setHeader('Cache-Control','no-store');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
 const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream')+'; charset=utf-8');
 res.end(fs.readFileSync(file));
}).listen(8776,'127.0.0.1',()=>console.log('Visual QA: http://127.0.0.1:8776/'));
