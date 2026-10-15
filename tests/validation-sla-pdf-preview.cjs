// Render the real PDF builder with synthetic data and a supplied jsPDF 2.5.1 UMD bundle.
const fs=require('node:fs'),path=require('node:path');
const {jsPDF}=require(path.resolve(process.argv[2]));
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
global.PortalStudyLabels=require('./study-labels-fixture.cjs');
const M=global.PortalIndicatorMetrics,U=require('../js/indicator-dashboard.js'),R=require('../js/indicator-report.js');
const rows=Array.from({length:32},(_,i)=>({id:String(i+1),_module:i%5?'blocking':'smart',_batchId:1,estudio:i%2?'Tradicional':'Lindley',pais:i%2?'Panamá':'Perú',fecha:'2026-10-10',
  assignedValidatorId:'v'+i,_validatorName:i===2?'Validador con un nombre extenso para comprobar el ajuste en varias líneas':'Validador '+String(i+1).padStart(2,'0'),_validatorCode:'VAL-'+(i+1),
  startedAt:i===29?null:'2026-10-10T15:00:00Z',completedAt:i===30?'2026-10-10T14:00:00Z':new Date(Date.parse('2026-10-10T15:00:00Z')+(i+1)*65*1000).toISOString(),validationStatus:i===31?'en_progreso':'completada',
  kpis:[{name:'Disponibilidad',needsReview:true},{name:'Precio',needsReview:true}],validationResults:{Disponibilidad:{status:'aplica',decisionAt:'2026-10-10T16:00:00Z'},Precio:{status:'no_aplica',tipificacion:'Fuera de alcance',decisionAt:'2026-10-10T16:00:00Z'}}}));
const result=M.compute(U.adapt(rows,[],a=>a.pais,'all'),{asOf:'2026-10-15'});
const snapshot={asOf:'2026-10-15',scope:'DATOS DE PRUEBA | Bloqueantes + Smart | Todos los estudios | Octubre 2026',result,trend:U.monthlyTrend(result,'2026-10',6),signals:R.signals(result)};
const pdf=R.buildPdf(jsPDF,snapshot),output=path.resolve(process.argv[3] || 'tmp/pdfs/indicadores-sla-qa.pdf');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(pdf.output('arraybuffer')));
console.log(JSON.stringify({output,pages:pdf.internal.getNumberOfPages(),sla:result.sla.meanSeconds,samples:result.sla.measured}));
