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
 function sectionTable(title,headers,rows,widths){
 const drawHeader=()=>{text(title,M,y,12,'navy',true);y+=5;pdf.setFillColor(230,240,250);pdf.roundedRect(M,y,U,10,1,1,'F');let x=M;headers.forEach((v,i)=>{text(v,x+3,y+6,8,'navy',true);x+=widths[i];});y+=10;};
 drawHeader();if(!rows.length){text('Sin revisiones terminadas.',M+3,y+7,9,'gray');y+=14;return;}
 rows.forEach((row,index)=>{const lines=row.map((v,i)=>wrap(v,widths[i]-6));const height=Math.max(8,...lines.map(v=>v.length*3.7+4));if(y+height>H-19){page(title+' · continuación');drawHeader();}if(index%2===0){pdf.setFillColor(247,250,253);pdf.rect(M,y,U,height,'F');}let x=M;lines.forEach((v,i)=>{text(v,x+3,y+5,8,i===headers.length-1?'red':'navy');x+=widths[i];});y+=height;});y+=10;
 }
 if(!history)throw new Error('No se pudo obtener el consolidado de revisiones terminadas.');
 historicalSection=true;
 const h=history.stats||{},round=v=>v==null?'Sin base':Number(v).toLocaleString('es-CO',{maximumFractionDigits:1});
 page('Resumen ejecutivo · revisiones completadas');
 paragraph('Periodo: '+(h.first_day||'Sin registros')+' al '+(h.last_day||'Sin registros')+' · Consolidado histórico · Unidad: '+unit+'.');
 const metrics=[['Revisadas',number(h.completed),'Total completado','blue'],['Promedio diario',round(h.daily_average),number(h.active_days)+' días con actividad','cyan'],['Con errores',number(h.errors),percent(h.errors,h.completed)+' de lo revisado','red'],['Tiempo promedio',duration(h.mean_seconds),'Inicio a cierre de revisión','purple']];
 metrics.forEach(([label,value,hint,tone],i)=>{const rgb=colors[tone],x=M+i*U/4,yy=64;pdf.setFillColor(...rgb.map(c=>Math.round(c*.08+255*.92)));pdf.roundedRect(x,yy,U/4-4,30,3,3,'F');pdf.setFillColor(...rgb);pdf.roundedRect(x,yy,1.5,30,.5,.5,'F');text(label,x+5,yy+7,9,'gray');text(value,x+5,yy+19,18,tone,true);text(hint,x+5,yy+26,7,'gray');});y=106;
 sectionTable('Gestión por analista',['Analista','Revisadas','Prom./día activo','Tiempo promedio','Con errores','% error'],(history.analysts||[]).filter(a=>Number(a.completed)>0).sort((a,b)=>b.completed-a.completed).map(a=>[a.name,number(a.completed),round(a.active_days?a.completed/a.active_days:null),duration(a.mean_seconds),number(a.errors),percent(a.errors,a.completed)]),[85,34,40,44,34,32]);
 if(y+14<=H-18){text(wrap('Promedio diario: completadas / días con actividad. Error: al menos una decisión incorrecta. Solo gestión terminada; incluye el historial de analistas retirados.',U,8),M,y,8,'gray');}
 page('Resultados por estudio y país');
 const rows=(history.study_countries||[]).filter(r=>Number(r.completed)>0).sort((a,b)=>String(a.study).localeCompare(String(b.study))||String(a.country).localeCompare(String(b.country),'es'));
 let previousStudy='';
 sectionTable('Detalle consolidado',['Estudio','País','Revisadas','Con errores','% error'],rows.map(r=>{const label=r.study===previousStudy?'':studyLabel(r.study);previousStudy=r.study;return [label,r.country,number(r.completed),number(r.errors),percent(r.errors,r.completed)];}),[82,72,40,40,35]);
 if(y+18<=H-18){text(wrap('PQR cuenta auditorías y QA cuenta alertas individuales. El porcentaje de error usa las revisiones terminadas de cada fila. Los países provienen de los datos originales de la auditoría.',U,8),M,y,8,'gray');}
 page('Gestión diaria · revisiones completadas');
 paragraph('Fecha de finalización de la revisión, hora de Colombia. Solo se muestran días con gestión completada.');
 const daily=[...(history.daily||[])].filter(r=>Number(r.completed)>0).sort((a,b)=>String(a.day).localeCompare(String(b.day)));
 sectionTable('Detalle por día',['Fecha de cierre','Revisadas','Con errores','% error'],daily.map(r=>[String(r.day||'').split('-').reverse().join('/'),number(r.completed),number(r.errors),percent(r.errors,r.completed)]),[89,60,60,60]);
 const total=pdf.getNumberOfPages();for(let i=1;i<=total;i++){pdf.setPage(i);pdf.setDrawColor(220,227,239);pdf.line(M,H-13,W-M,H-13);text('dichter & neira | Control de calidad '+name,M,H-7,8,'gray');text(i+' / '+total,W-M-13,H-7,8,'gray');}
 return pdf;
}
