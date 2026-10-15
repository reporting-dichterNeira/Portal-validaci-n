global.PortalStudyLabels=require('./study-labels-fixture.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const R=require('../js/indicator-report.js');
const M=global.PortalIndicatorMetrics;
function result(applies,total,old=0,missing=0) {
  return {counts:{total,applies,rejects:0,pending:total-applies,coverage:total?applies/total:null},
    backlog:{old:Array.from({length:old},()=>({age:20})),recent:Array.from({length:Math.max(0,total-applies-old-missing)},()=>({age:2})),missing:Array.from({length:missing},()=>({age:null}))}};
}
test('semáforos respetan límites y no muestran una base vacía o sin fechas como verde',()=>{
  for(const [applies,total,tone] of [[95,100,'green'],[94,100,'amber'],[80,100,'amber'],[79,100,'red'],[0,0,'gray']])
    assert.equal(R.signals(result(applies,total))[0].tone,tone);
  assert.equal(R.signals(result(0,10,1))[1].tone,'amber');
  assert.equal(R.signals(result(0,10,2))[1].tone,'red');
  assert.equal(R.signals(result(10,10))[1].tone,'green');
  assert.equal(R.signals(result(0,10,0,10))[1].tone,'gray');
  assert.match(R.signals(result(0,10,0,10))[1].detail,/10 sin antigüedad/);
});
const audit=(id,module,fecha,status)=>({id:String(id),_module:module,_batchId:1,estudio:'Moderno',pais:'Panamá',fecha,
  fechaAuditoriaOriginal:fecha,idPDV:'99',kpis:[{name:'K',needsReview:true}],validationResults:status?{K:{status,tipificacion:'Motivo',observaciones:'=dato; "comillas"'}}:{}});
test('CSV histórico mantiene módulos, decisiones, fechas faltantes y observaciones con escape seguro',()=>{
  const audits=[audit(1,'blocking','2026-09-01','aplica'),audit(1,'smart','2026-10-01','no_aplica'),audit(2,'smart','',null)];
  const before=JSON.stringify(audits),data=U.alertExport(audits);
  assert.equal(data.rows.length,3);assert.equal(data.audits,3);
  assert.deepEqual(data.rows.map(row=>row[0]),['Bloqueantes','Smart','Smart']);
  assert.deepEqual(data.rows.map(row=>row[15]),['aplica','no_aplica','pendiente']);
  assert.equal(data.rows[2][3],null);assert.equal(data.counts.total,3);
  assert.equal(data.counts.applies+data.counts.rejects+data.counts.pending,3);
  assert.match(U.csv(data.headers,data.rows),/"'=dato; ""comillas"""/);
  assert.equal(JSON.stringify(audits),before);
});
test('PDF conserva mes, módulo y dimensiones de la selección con evolución de meses anteriores',()=>{
  const rows=[audit(1,'blocking','2026-09-01','aplica'),audit(2,'blocking','2026-10-01','no_aplica'),audit(3,'smart','2026-10-01','aplica')];
  const app={currentView:'visualizations',selectedMetricsMonth:'2026-10',selectedStudies:['Moderno'],selectedMetricsCountry:'Panamá',
    visualizationDateFrom:'2026-09-01',visualizationDateTo:'2026-10-14',indicatorFilters:{region:'all',channel:'all',subchannel:'all'},
    getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais,getReportAuditSource:()=>rows,
    getFilteredAuditsForReports:(source=rows,options={})=>source.filter(a=>options.ignoreMonth||a.fecha.startsWith('2026-10'))};
  const snapshot=R.buildSnapshot(app);
  assert.equal(snapshot.result.counts.total,1);assert.equal(snapshot.result.counts.rejects,1);
  assert.deepEqual(snapshot.trend.map(r=>[r.month,r.total]),[['2026-09',1],['2026-10',1]]);
  for(const value of ['Bloqueantes','Mes: 2026-10','Desde: 2026-09-01','Hasta: 2026-10-14','País: Panamá'])assert.ok(snapshot.scope.includes(value),value);
  assert.equal(snapshot.signals[0].tone,'green');
});
test('resumen muestra semáforos con textos y PDF está disponible desde todas las gráficas',()=>{
  assert.match(U.signalPanel(result(0,10)),/Requiere atención/);
  assert.match(U.signalPanel(result(10,10)),/95% o más/);
  const target={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,parentElement:{children:[]}};
  global.document={getElementById:()=>target};
  const app={currentView:'visualizations',reportsSubtab:'metrics',getVisualizationModuleFilter:()=> 'blocking',getReportCountry:a=>a.pais};
  try {
    for(const [section] of U.journey){app.indicatorOperationalSection=section;U.render(app,[audit(1,'blocking','2026-10-01','aplica')]);assert.match(target.innerHTML,/data-indicator-pdf/);}
  } finally {delete global.document;}
});

test('desglose ordena por frecuencia recibida y reconcilia Aplica, No aplica y pendientes de ambos módulos',()=>{
  const rows=[
    {id:'1',_module:'blocking',study:'Moderno',periodDate:'2026-10-01',kpis:[{name:'Precio',needsReview:true,decision:'aplica'},{name:'Disponibilidad',needsReview:true,decision:'no_aplica'}]},
    {id:'1',_module:'smart',study:'Moderno',periodDate:'2026-10-01',kpis:[{name:'Precio',needsReview:true,decision:'no_aplica'},{name:'Exhibición',needsReview:true}]},
    {id:'2',_module:'smart',study:'Moderno',periodDate:'2026-10-01',kpis:[{name:'Precio',needsReview:true}]}
  ];
  const result=M.compute(M.normalizeAudits(rows),{asOf:'2026-10-14'}),before=JSON.stringify(result.rejectedTypes);
  const groups=R.alertBreakdown(result);
  assert.deepEqual(groups.map(r=>[r.name,r.total,r.applies,r.rejects,r.pending]),[
    ['Precio',3,1,1,1],['Disponibilidad',1,0,1,0],['Exhibición',1,0,0,1]
  ]);
  assert.equal(groups.reduce((sum,r)=>sum+r.total,0),result.counts.total);
  for(const row of groups)assert.equal(row.total,row.applies+row.rejects+row.pending);
  assert.equal(JSON.stringify(result.rejectedTypes),before);
});

class PdfRecorder {
  constructor(){this.pages=[[]];this.current=0;this.internal={pageSize:{getWidth:()=>297,getHeight:()=>210},getNumberOfPages:()=>this.pages.length};}
  addPage(){this.pages.push([]);this.current=this.pages.length-1;}
  setPage(page){this.current=page-1;}
  setFillColor(){} setDrawColor(){} setTextColor(){} setFont(){} setFontSize(){} rect(){} roundedRect(){} line(){} circle(){}
  splitTextToSize(text,width){return String(text).match(new RegExp('.{1,'+Math.floor(width*.7)+'}','g')) || [''];}
  text(text,x,y){assert.ok(x>=0&&x<297&&y>=0&&y<210,'Texto fuera de página');this.pages[this.current].push(Array.isArray(text)?text.join(' '):text);}
}
test('PDF pagina todos los tipos de alerta y mantiene ranking y columnas incluso con nombres largos',()=>{
  const audits=M.normalizeAudits(Array.from({length:35},(_,i)=>({id:String(i+1),study:'Moderno',periodDate:'2026-10-01',
    kpis:[{name:'Tipo '+String(i+1).padStart(2,'0')+' - '+('Nombre largo de alerta '.repeat(3)),needsReview:true,decision:i%3===0?'aplica':i%3===1?'no_aplica':'pendiente'}]})));
  const result=M.compute(audits,{asOf:'2026-10-14'});
  const pdf=R.buildPdf(PdfRecorder,{asOf:'2026-10-14',scope:'Todos los estudios',result,trend:[],signals:R.signals(result)});
  const pages=pdf.pages.filter(page=>page.some(text=>text.includes('Desglose por tipo de alerta')));
  assert.ok(pages.length>1);
  const all=pages.flat().join('\n');
  for(let i=1;i<=35;i++)assert.ok(all.includes('Tipo '+String(i).padStart(2,'0')),String(i));
  for(const page of pages)for(const label of ['Recibidas','Aplica','No aplica','Pendientes'])assert.ok(page.includes(label),label);
  assert.ok(all.indexOf('Tipo 01')<all.indexOf('Tipo 35'));
});
test('PDF sin alertas muestra ausencia de datos en el desglose',()=>{
  const result=M.compute([],{asOf:'2026-10-14'});
  const pdf=R.buildPdf(PdfRecorder,{asOf:'2026-10-14',scope:'Sin selección',result,trend:[],signals:R.signals(result)});
  assert.ok(pdf.pages.flat().includes('Sin alertas para el alcance seleccionado.'));
});
