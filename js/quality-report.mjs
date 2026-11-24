import {number,percent,duration,studyLabel} from './pqr-domain.mjs?v=1.1';

// Aggregate dashboard figures are not limited by the paginated review list.
export function buildQualityPdf(JsPDF,data,operation='pqr',generatedAt=new Date()){
 const qa=operation==='qa',name=qa?'QA':'PQR',unit=qa?'alertas':'auditorías',s=data.stats||{};
 const pdf=new JsPDF({unit:'mm',format:'a4',orientation:'landscape'});
 const W=297,H=210,M=14,U=W-2*M;
 const colors={navy:[36,51,95],blue:[13,92,171],green:[18,151,71],gray:[97,112,136],amber:[168,92,0],red:[195,45,85]};
 const clean=v=>String(v??'').replace(/[→]/g,' a ').replace(/[—–]/g,'-').replace(/\p{Extended_Pictographic}/gu,'');
 const text=(v,x,y,size=9,color='navy',bold=false)=>{pdf.setFont('helvetica',bold?'bold':'normal');pdf.setFontSize(size);pdf.setTextColor(...colors[color]);pdf.text(Array.isArray(v)?v.map(clean):clean(v),x,y);};
 const wrap=(v,w,size=8)=>{pdf.setFont('helvetica','normal');pdf.setFontSize(size);return pdf.splitTextToSize(clean(v),w);};
 const stamp=new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'short',timeStyle:'short'}).format(generatedAt);
 let y=0;
 function page(title){if(pdf.getNumberOfPages()>1||y)pdf.addPage();pdf.setFillColor(...colors.navy);pdf.rect(0,0,W,32,'F');pdf.setFont('helvetica','bold');pdf.setFontSize(18);pdf.setTextColor(255,255,255);pdf.text('Portal de alertas | Operación '+name,M,14);pdf.setFontSize(10);pdf.text(clean(title),M,24);text('Jornada de validación original: '+data.day,M,41,10,'blue',true);text('Generado: '+stamp+' (Colombia)',177,41,8,'gray');y=51;}
 function paragraph(value){const lines=wrap(value,U,9);if(y+lines.length*4.5>H-18)page('Resumen operativo · continuación');text(lines,M,y,9,'gray');y+=lines.length*4.5+5;}
 function table(title,headers,rows,widths){page(title);const header=()=>{let x=M;pdf.setFillColor(235,241,249);pdf.rect(M,y,U,15,'F');headers.forEach((v,i)=>{text(wrap(v,widths[i]-4),x+2,y+5,8,'navy',true);x+=widths[i];});y+=15;};header();if(!rows.length){paragraph('Sin registros para esta jornada.');return;}
 rows.forEach((row,index)=>{const lines=row.map((v,i)=>wrap(v,widths[i]-4));const height=Math.max(10,...lines.map(v=>v.length*4+5));if(y+height>H-19){page(title+' · continuación');header();}if(index%2===0){pdf.setFillColor(248,250,253);pdf.rect(M,y,U,height,'F');}let x=M;lines.forEach((v,i)=>{text(v,x+2,y+5,8);x+=widths[i];});y+=height;});}
 page('Resumen de la operación');
 const selected=Number(s.selected||0),completed=Number(s.completed||0),assigned=Number(s.assigned||0),errors=Number(s.errors||0),unevaluable=Number(s.not_evaluable||0);
 const cards=[['Base elegible',number(s.eligible)],['Meta de revisión',number(s.target)],['Seleccionadas',number(selected)],['Asignadas',number(assigned)],['Terminadas',number(completed)],['Pendientes de terminar',number(Math.max(0,selected-completed))],['Avance',percent(completed,selected)],['SLA promedio de revisión',duration(s.mean_seconds)]];
 cards.forEach(([label,value],i)=>{const x=M+(i%4)*(U/4),yy=51+Math.floor(i/4)*29;pdf.setDrawColor(220,227,239);pdf.roundedRect(x,yy,U/4-4,25,2,2,'S');text(label,x+3,yy+7,8,'gray');text(value,x+3,yy+18,16,'blue',true);});y=116;
 paragraph(qa?'Unidad: alertas individuales marcadas No válida en Bloqueantes. El porcentaje QA se calcula sobre las alertas elegibles; una auditoría puede aportar varias alertas.':'Unidad: auditorías de Bloqueantes completadas en la jornada original. La meta PQR suma las metas de cada estudio, redondeadas hacia arriba.');
 text('Avance de la muestra',M,y,11,'navy',true);y+=5;pdf.setFillColor(235,241,249);pdf.rect(M,y,U,5,'F');if(selected){pdf.setFillColor(...colors.green);pdf.rect(M,y,U*Math.min(1,completed/selected),5,'F');}y+=13;
 paragraph(number(completed)+' de '+number(selected)+' '+unit+' terminadas. Sin asignar: '+number(Math.max(0,selected-assigned))+'. Terminadas el mismo día: '+number(s.on_time)+'.');
 paragraph('Resultados terminados: '+number(Math.max(0,completed-errors-unevaluable))+' correctos; '+number(errors)+' con errores; '+number(unevaluable)+' no evaluables. La revisión conserva la decisión original del validador.');
 const studies=data.study_stats||[];
 table('Asignación y avance por estudio',['Estudio','Responsable(s)','Elegibles','Meta','Seleccionadas','Asignadas','Terminadas','Avance'],studies.map(r=>[studyLabel(r.study),r.analyst_name||'Sin responsable',number(r.eligible),number(r.target),number(r.selected),number(r.assigned),number(r.completed),percent(r.completed,r.selected)]),[45,66,25,22,30,28,28,25]);
 y+=7;if(qa&&y<H-28)paragraph('Responsables: configuración de la jornada. En estudios compartidos, la muestra se reparte entre ambos responsables. SOVI/SOCI siguen la asignación del especialista.');
 const team=(data.analysts||[]).filter(a=>!a.deleted_at||Number(a.assigned)||Number(a.previous_pending));
 table('Gestión por analista',['Analista','Asignadas','En revisión','Terminadas','Avance','Mismo día','SLA promedio','Con errores','Pendiente anterior'],team.map(a=>[a.name+(a.deleted_at?' (eliminado)':''),number(a.assigned),number(a.in_progress),number(a.completed),percent(a.completed,a.assigned),number(a.on_time),duration(a.mean_seconds),number(a.errors),number(a.previous_pending)]),[65,24,26,27,24,25,29,24,25]);
 y+=8;if(y>H-42)page('Criterios del resumen');
 paragraph('Las cifras corresponden a toda la jornada seleccionada, independientemente de la página o del estado mostrado en la lista. El pendiente anterior se informa por separado y no se suma a la muestra de la jornada.');
 paragraph('SLA de revisión: tiempo entre inicio y cierre de la segunda revisión. Cumplimiento del mismo día: cierre en la fecha original, hora de Colombia. Los resultados reflejan el estado actual al generar el PDF.');
 const total=pdf.getNumberOfPages();for(let i=1;i<=total;i++){pdf.setPage(i);pdf.setDrawColor(220,227,239);pdf.line(M,H-13,W-M,H-13);text('dichter & neira | Control de calidad '+name,M,H-7,8,'gray');text(i+' / '+total,W-M-13,H-7,8,'gray');}
 return pdf;
}
