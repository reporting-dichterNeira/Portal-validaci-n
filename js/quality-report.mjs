import {number,percent,duration,studyLabel} from './pqr-domain.mjs?v=1.1';

// Aggregate dashboard figures are not limited by the paginated review list.
export function buildQualityPdf(JsPDF,data,operation='pqr',generatedAt=new Date()){
 const history=data.consolidated;
 const qa=operation==='qa',name=qa?'QA':'PQR',unit=qa?'alertas':'auditorías',s=data.stats||{};
 const pdf=new JsPDF({unit:'mm',format:'a4',orientation:'landscape'});
 const W=297,H=210,M=14,U=W-2*M;
 const colors={navy:[36,51,95],blue:[13,92,171],green:[18,151,71],gray:[97,112,136],amber:[168,92,0],red:[195,45,85],cyan:[0,152,181],purple:[111,67,190]};
 const clean=v=>String(v??'').replace(/[→]/g,' a ').replace(/[—–]/g,'-').replace(/\p{Extended_Pictographic}/gu,'');
 const text=(v,x,y,size=9,color='navy',bold=false)=>{pdf.setFont('helvetica',bold?'bold':'normal');pdf.setFontSize(size);pdf.setTextColor(...colors[color]);pdf.text(Array.isArray(v)?v.map(clean):clean(v),x,y);};
 const wrap=(v,w,size=8)=>{pdf.setFont('helvetica','normal');pdf.setFontSize(size);return pdf.splitTextToSize(clean(v),w);};
 const stamp=new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'short',timeStyle:'short'}).format(generatedAt);
 let y=0,historicalSection=false,historicalStart=0;
 function page(title){if(pdf.getNumberOfPages()>1||y)pdf.addPage();pdf.setFillColor(...colors.navy);pdf.rect(0,0,W,32,'F');pdf.setFillColor(...colors.cyan);pdf.rect(0,32,W,1.5,'F');pdf.setFont('helvetica','bold');pdf.setFontSize(18);pdf.setTextColor(255,255,255);pdf.text('Portal de alertas | Operación '+name,M,14);pdf.setFontSize(10);pdf.text(clean(title),M,24);text(historicalSection?'Alcance: consolidado histórico completo':'Jornada de validación original: '+data.day,M,41,10,'blue',true);text('Generado: '+stamp+' (Colombia)',177,41,8,'gray');y=51;}
 function paragraph(value){const lines=wrap(value,U,9);if(y+lines.length*4.5>H-18)page('Resumen operativo · continuación');text(lines,M,y,9,'gray');y+=lines.length*4.5+5;}
 function table(title,headers,rows,widths){page(title);const header=()=>{let x=M;pdf.setFillColor(225,236,250);pdf.rect(M,y,U,15,'F');pdf.setFillColor(...colors.blue);pdf.rect(M,y,1.2,15,'F');headers.forEach((v,i)=>{text(wrap(v,widths[i]-4),x+2,y+5,8,'navy',true);x+=widths[i];});y+=15;};header();if(!rows.length){paragraph('Sin registros para esta jornada.');return;}
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
 if(history){
 historicalSection=true;historicalStart=pdf.getNumberOfPages()+1;
 const h=history.stats||{},round=v=>v==null?'Sin base':Number(v).toLocaleString('es-CO',{maximumFractionDigits:1});
 page('Consolidado histórico de la operación');
 paragraph('Periodo de jornadas: '+(h.first_day||'Sin registros')+' a '+(h.last_day||'Sin registros')+'. Corte al momento de generar el informe. Incluye todo el histórico disponible, independiente de la jornada y filtros de la pantalla.');
 const metrics=[['Total revisado',number(h.completed)],['Promedio por día activo',round(h.daily_average)],['Días con revisiones',number(h.active_days)],['Con errores',number(h.errors)],['Tasa de error',percent(h.errors,h.completed)],['Asignadas',number(h.assigned)],['Pendientes / en curso',number(Number(h.pending||0)+Number(h.in_progress||0))],['SLA promedio',duration(h.mean_seconds)]];
 metrics.forEach(([label,value],i)=>{const tone=['blue','cyan','purple','red','red','purple','amber','cyan'][i],rgb=colors[tone],x=M+(i%4)*(U/4),yy=72+Math.floor(i/4)*31;pdf.setFillColor(...rgb.map(c=>Math.round(c*.08+255*.92)));pdf.roundedRect(x,yy,U/4-4,27,3,3,'F');pdf.setFillColor(...rgb);pdf.roundedRect(x,yy,1.5,27,.5,.5,'F');text(label,x+5,yy+8,8,'gray');text(value,x+5,yy+20,17,tone,true);});y=140;
 paragraph('Promedio diario = revisiones terminadas / días con al menos una revisión terminada (fecha de cierre, Colombia). No es un promedio por persona ni por días calendario. En PQR se cuentan auditorías; en QA se cuentan alertas individuales.');
 paragraph('Con errores: revisiones terminadas cuyo resultado fue Validación con errores. Tasa de error = con errores / total terminado. No evaluables: '+number(h.not_evaluable)+'. Terminadas el mismo día de su jornada: '+number(h.on_time)+'.');
 page('Presencia y desempeño por país');
 paragraph('Consolidado histórico por país. Las barras comparan el volumen revisado; el tramo rojo identifica revisiones con errores. Pendientes incluye trabajo sin terminar.');
 const territories=[...(history.countries||[])].sort((a,b)=>Number(b.completed)-Number(a.completed));
 const maximum=Math.max(1,...territories.map(c=>Number(c.completed||0)));
 if(!territories.length)paragraph('No hay países con registros para este alcance.');
 territories.forEach((r,i)=>{if(y+32>H-19)page('Desempeño por país · continuación');const tone=['blue','cyan','purple'][i%3];pdf.setFillColor(246,249,253);pdf.roundedRect(M,y,U,29,2,2,'F');text(r.country,M+4,y+7,12,'navy',true);text(number(r.completed)+' revisadas',M+64,y+7,11,tone,true);text(percent(r.completed,h.completed)+' del total',M+120,y+7,9,'gray');text(number(r.errors)+' con errores | '+percent(r.errors,r.completed),M+175,y+7,9,'red',true);const barWidth=U-12,filled=barWidth*Number(r.completed||0)/maximum;pdf.setFillColor(224,231,240);pdf.roundedRect(M+5,y+11,barWidth,4,1,1,'F');if(filled){pdf.setFillColor(...colors[tone]);pdf.rect(M+5,y+11,filled,4,'F');if(r.errors){pdf.setFillColor(...colors.red);pdf.rect(M+5+filled*(1-r.errors/r.completed),y+11,filled*r.errors/r.completed,4,'F');}}text('Seleccionadas: '+number(r.selected)+'   |   Pendientes / en curso: '+number(r.pending)+'   |   Avance: '+percent(r.completed,r.selected),M+5,y+23,9,'gray');y+=34;});
 page('Productividad del equipo · vista ejecutiva');
 paragraph('Hasta diez analistas con más revisiones terminadas. El detalle completo por persona y país se incluye en las siguientes páginas.');
 const leaders=[...(history.analysts||[])].filter(a=>a.name!=='Sin asignar').sort((a,b)=>b.completed-a.completed).slice(0,10),maxLeader=Math.max(1,...leaders.map(a=>Number(a.completed||0)));
 leaders.forEach((a,i)=>{const yy=y+i*11;const label=clean(a.name);text(label.length>38?label.slice(0,35)+'...':label,M,yy+4,8,'navy',true);pdf.setFillColor(231,237,246);pdf.rect(M+80,yy,U-120,5,'F');if(a.completed){pdf.setFillColor(...colors[i%2?'cyan':'blue']);pdf.rect(M+80,yy,(U-120)*a.completed/maxLeader,5,'F');}text(number(a.completed),W-M-31,yy+4,10,'blue',true);});
 table('Histórico · productividad por persona',['Analista','Países','Asignadas','Terminadas','Prom./día activo','Días activos','Con errores','% error','SLA'],(history.analysts||[]).map(a=>[a.name,a.countries||'Sin país',number(a.assigned),number(a.completed),round(a.active_days? a.completed/a.active_days:null),number(a.active_days),number(a.errors),percent(a.errors,a.completed),duration(a.mean_seconds)]),[52,52,24,26,28,23,22,19,23]);
 table('Histórico · detalle por persona y país',['Analista','País','Asignadas','Terminadas','Con errores','% error'],(history.analyst_countries||[]).map(r=>[r.name,r.country,number(r.assigned),number(r.completed),number(r.errors),percent(r.errors,r.completed)]),[75,50,36,38,35,35]);
 table('Histórico · gestión por país',['País','Seleccionadas','Terminadas','Pendientes / en curso','Con errores','% error'],(history.countries||[]).map(r=>[r.country,number(r.selected),number(r.completed),number(r.pending),number(r.errors),percent(r.errors,r.completed)]),[65,43,40,46,38,37]);
 table('Histórico · gestión por estudio',['Estudio','Seleccionadas','Terminadas','Pendientes / en curso','Con errores','% error'],(history.studies||[]).map(r=>[studyLabel(r.study),number(r.selected),number(r.completed),number(r.pending),number(r.errors),percent(r.errors,r.completed)]),[65,43,40,46,38,37]);
 table('Histórico · evolución diaria de revisiones',['Fecha de cierre (Colombia)','Revisiones terminadas','Con errores','% error'],(history.daily||[]).map(r=>[r.day,number(r.completed),number(r.errors),percent(r.errors,r.completed)]),[90,65,57,57]);
 table('Histórico · errores detectados por KPI',['KPI','Alertas evaluadas','Decisiones incorrectas','% de decisiones incorrectas'],(history.errors||[]).map(r=>[r.kpi,number(r.reviewed),number(r.errors),percent(r.errors,r.reviewed)]),[120,48,48,53]);
 y+=8;paragraph('Esta tabla cuenta decisiones de alertas, no auditorías. Una auditoría PQR puede contener varias decisiones incorrectas; por eso esta suma puede superar el número de revisiones con errores. El histórico excluye únicamente revisiones excluidas por las reglas vigentes de la operación; conserva la gestión de analistas retirados.');
 }
 if(historicalStart){const count=pdf.getNumberOfPages()-historicalStart+1;for(let i=0;i<count;i++)pdf.movePage(historicalStart+i,1+i);}
 const total=pdf.getNumberOfPages();for(let i=1;i<=total;i++){pdf.setPage(i);pdf.setDrawColor(220,227,239);pdf.line(M,H-13,W-M,H-13);text('dichter & neira | Control de calidad '+name,M,H-7,8,'gray');text(i+' / '+total,W-M-13,H-7,8,'gray');}
 return pdf;
}
