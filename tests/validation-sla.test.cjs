const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const M=global.PortalIndicatorMetrics,U=require('../js/indicator-dashboard.js'),R=require('../js/indicator-report.js');
const asOf='2026-10-15';
const audit=(id,seconds=60,extra={})=>({id:String(id),_module:'blocking',_batchId:1,estudio:'Tradicional',pais:'Panamá',fecha:'2026-10-10',fechaAuditoriaOriginal:'2026-10-10',
  assignedValidatorId:'v1',_validatorName:'Validador Uno',_validatorCode:'VAL-1',validationStatus:'completada',
  startedAt:'2026-10-10T15:00:00Z',completedAt:new Date(Date.parse('2026-10-10T15:00:00Z')+seconds*1000).toISOString(),durationSeconds:8,
  kpis:[{name:'K',needsReview:true}],validationResults:{K:{status:'aplica'}},...extra});

test('SLA uses actual start and finish, preserves zero, and never uses synthetic stored duration',()=>{
  assert.deepEqual(M.auditValidationSla(audit(1,65),asOf),{state:'valid',seconds:65});
  assert.equal(M.auditValidationSla(audit(2,0),asOf).seconds,0);
  for(const [extra,state] of [[{startedAt:null},'missing'],[{startedAt:'2026-10-10'},'missing'],[{startedAt:'no es fecha'},'invalid'],[{completedAt:'2026-10-10T14:59:00Z'},'invalid'],[{completedAt:'2026-10-16T15:00:00Z'},'future'],[{validationStatus:'en_progreso'},'pending']]){
    const measured=M.auditValidationSla(audit(3,60,extra),asOf);assert.equal(measured.state,state);assert.equal(measured.seconds,null);
  }
  assert.equal(M.formatSla(65),'1 min 5 s');assert.equal(M.formatSla(3660),'1 h 1 min');assert.equal(M.formatSla(0),'0 s');assert.equal(M.formatSla(null),'Sin muestras');
});

test('overall average is weighted by audits, with median and nearest-rank P90, independently of KPI counts',()=>{
  const many=Array.from({length:8},(_,i)=>({name:'K'+i,needsReview:true}));
  const rows=[audit(1,60,{kpis:many}),audit(2,120),audit(3,600,{assignedValidatorId:'v2',_validatorName:'Validador Dos'}),audit(4,1,{startedAt:null}),audit(5,999,{validationStatus:'en_progreso'})];
  const s=M.compute(U.adapt(rows),{asOf}).sla;
  assert.equal(s.completed,4);assert.equal(s.measured,3);assert.equal(s.missing,1);
  assert.equal(s.totalSeconds,780);assert.equal(s.meanSeconds,260);assert.equal(s.medianSeconds,120);assert.equal(s.p90Seconds,600);
  assert.equal(s.validators[0].id,'v1');assert.equal(s.validators[0].meanSeconds,90);assert.equal(s.validators[0].measured,2);
  assert.equal(s.validators[1].meanSeconds,600);
  const blank=M.compute([],{asOf}).sla;assert.equal(blank.meanSeconds,null);assert.equal(blank.totalSeconds,null);assert.deepEqual(blank.validators,[]);
});

test('study/date/module scopes and canonical versions govern SLA; validator identity is distinct from field auditor',()=>{
  const rows=[audit(1,60),audit(1,120,{_module:'smart'}),audit(2,600,{fecha:'2026-09-01'}),audit(3,900,{_pendingResolution:'removed'}),audit(1,3600,{_batchId:0})];
  const all=M.compute(U.adapt(rows,[],null,'all'),{asOf,from:'2026-10-01'}).sla;
  assert.equal(all.measured,2);assert.equal(all.meanSeconds,90);
  assert.equal(M.compute(U.adapt(rows,[],null,'smart'),{asOf}).sla.meanSeconds,120);
  assert.equal(M.compute(U.adapt(rows),{asOf,country:'Chile'}).sla.measured,0);
  const named=U.adapt([audit(4,60,{_validatorName:'Ana',databricksGeography:{auditor:'Campo',auditorSource:'storeview.slv_sv_ceres_ag_export.nombre_usuario'}})])[0];
  assert.equal(named.validatorName,'Ana');assert.equal(named.auditor,'Campo');
});

test('historical CSV repeats the audit total per alert while retaining missing measurements and validator metadata',()=>{
  const rows=[audit(1,125,{kpis:[{name:'K',needsReview:true},{name:'Otro',needsReview:true}]}),audit(2,900,{startedAt:null})];
  const out=U.alertExport(rows),column=out.headers.indexOf('SLA total de validación (seg)');
  assert.equal(column>=0,true);assert.deepEqual(out.rows.map(r=>r[column]),[125,125,'']);
  assert.equal(out.rows[0][out.headers.indexOf('Validador')],'Validador Uno');
  assert.equal(out.rows[2][out.headers.indexOf('Estado de medición SLA')],'Sin inicio o cierre con hora');
});

test('every metrics chapter downloads audit SLA under the same filters, summary has average and timing has exportable validator table',()=>{
  const blobs=[],callbacks={};const originalURL=URL.createObjectURL;
  const target={innerHTML:'',querySelectorAll:()=>[],querySelector:s=>s==='[data-indicator-download]'?{addEventListener:(_,fn)=>callbacks.download=fn}:null};
  target.parentElement={children:[target]};
  global.document={getElementById:()=>target,createElement:()=>({click(){}})};
  URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:test';};
  const rows=[audit(1,125)];const app={currentView:'visualizations',reportsSubtab:'metrics',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais};
  try{
    for(const [section] of U.journey){
      app.indicatorOperationalSection=section;U.render(app,rows);callbacks.download();
      assert.match(target.innerHTML,/data-indicator-download/);
      if(section==='summary')assert.match(target.innerHTML,/SLA promedio en validar/);
      if(section==='timing'){assert.match(target.innerHTML,/SLA por validador/);assert.match(target.innerHTML,/Mediana/);assert.match(target.innerHTML,/P90/);assert.match(target.innerHTML,/Validador Uno/);}
    }
  }finally{delete global.document;URL.createObjectURL=originalURL;}
  return Promise.all(blobs.map(async blob=>{const parsed=M.parseCSV(await blob.text());assert.equal(parsed[0]['SLA total de validación (seg)'],'125');assert.equal(parsed[0].Validador,'Validador Uno');}));
});

test('PDF includes SLA average card and paginates all validators without changing the filtered sample',()=>{
  class Pdf {
    constructor(){this.pages=[[]];this.current=0;this.internal={pageSize:{getWidth:()=>297,getHeight:()=>210},getNumberOfPages:()=>this.pages.length};}
    addPage(){this.pages.push([]);this.current=this.pages.length-1;}setPage(p){this.current=p-1;}
    setFillColor(){}setDrawColor(){}setTextColor(){}setFont(){}setFontSize(){}rect(){}roundedRect(){}line(){}circle(){}
    splitTextToSize(t,w){return String(t).match(new RegExp('.{1,'+Math.floor(w*.7)+'}','g'))||[''];}
    text(t,x,y){assert.ok(x>=0&&x<297&&y>=0&&y<210);this.pages[this.current].push(Array.isArray(t)?t.join(' '):t);}
  }
  const rows=Array.from({length:20},(_,i)=>audit(i+1,125,{assignedValidatorId:'v'+i,_validatorName:'Validador '+i}));
  const result=M.compute(U.adapt(rows),{asOf});
  const pdf=R.buildPdf(Pdf,{asOf,scope:'Panamá',result,trend:[],signals:R.signals(result)});
  assert.ok(pdf.pages[0].join('').replace(/\s/g,'').includes('SLApromedioenvalidar'));assert.match(pdf.pages[0].join(' '),/2 min 5 s/);
  const pages=pdf.pages.filter(p=>p.includes('dichter & neira | SLA de validación por validador'));
  assert.ok(pages.length>1);for(let i=0;i<20;i++)assert.ok(pages.flat().includes('Validador '+i+' | VAL-1'));
});
