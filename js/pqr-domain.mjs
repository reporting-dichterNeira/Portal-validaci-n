export const escapeText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const number=value=>Number(value||0).toLocaleString('es-CO');
export const percent=(value,total)=>total?((value/total)*100).toLocaleString('es-CO',{maximumFractionDigits:1})+'%':'Sin base';
export const today=(date=new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export const dateTime=value=>value?new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'—';
export function duration(value){if(value==null||!Number.isFinite(Number(value)))return 'Sin muestras';const s=Math.round(Number(value));return s<60?s+' s':Math.floor(s/60)+' min '+s%60+' s';}
export const decisionLabel=value=>({aplica:'Alerta válida · Aplica',no_aplica:'Alerta no válida · No aplica'}[value]||'Sin decisión final');
export const verdictLabel=value=>({correct:'Validación correcta',errors:'Validación con errores',not_evaluable:'No evaluable'}[value]||'Sin resultado');
export const studyLabel=value=>({Chile:'KO Tradicional CHILE',Tradicional:'KO Tradicional CAM',Moderno:'KO Moderno CAM'}[value]||value||'Sin estudio');
export const statusLabel=row=>row.overdue?'Vencida · '+(row.status==='in_progress'?'En revisión':'Pendiente'):({pending:'Pendiente',in_progress:'En revisión',completed:'Terminada'}[row.status]||row.status);
export function reasons(row){const r=row.reasons||{};return [row.selection==='random'?'Selección aleatoria':'Prioridad por riesgo',r.fast&&'Validación rápida',r.many_alerts&&'Varias alertas',r.many_invalid&&'Varios No aplica'].filter(Boolean).join(' · ');}
export function reviewError(kpis,results,complete=false){
 for(const k of kpis){const r=results[k.name];if(!r){if(complete)return 'Evalúa todas las alertas antes de completar.';continue;}
  if(!['correct','incorrect','not_evaluable'].includes(r.evaluation))return 'Selecciona una evaluación válida.';
  if(r.correct_decision&&!['aplica','no_aplica'].includes(r.correct_decision))return 'La decisión de corrección no es válida.';
  if(String(r.comment||'').length>4000)return 'El detalle no puede superar 4.000 caracteres.';
  if(r.evaluation==='not_evaluable'&&String(r.comment||'').trim().length<3)return 'Explica por qué la alerta no es evaluable.';
 }return '';
}
export function reviewResults(kpis,values,originalResults={},savedResults={}){
 const results=Object.create(null);
 for(const[k,i]of kpis.map((k,i)=>[k,i])){
  const evaluation=values['evaluation_'+i];if(!evaluation)continue;
  const original=originalResults[k.name]?.status,saved=savedResults[k.name]||{};
  // Infer an opposite only for a binary original decision; retain legacy corrections.
  const corrected=evaluation==='incorrect'?(original==='aplica'?'no_aplica':original==='no_aplica'?'aplica':saved.evaluation==='incorrect'?saved.correct_decision||'':''):'';
  results[k.name]={evaluation,correct_decision:corrected,comment:String(values['comment_'+i]||'').trim()};
 }
 return results;
}
export function csv(headers,rows){const cell=v=>{let s=String(v??'');if(typeof v==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return '\uFEFF'+[headers,...rows].map(r=>r.map(cell).join(';')).join('\r\n');}
export function safeUrl(value){try{const u=new URL(String(value));return u.protocol==='https:'?u.href:null;}catch{return null;}}
export function evidenceEntries(payload,kpi){
 const entries=[];for(const [scope,obj] of [['Auditoría',payload?.meta],['Auditoría',payload],['Alerta',kpi]]){
  for(const [key,value]of Object.entries(obj||{}))if(typeof value==='string'&&safeUrl(value))entries.push({label:scope+' · '+key,url:safeUrl(value)});
 }return [...new Map(entries.map(e=>[e.url,e])).values()];
}
export function exportRows(reviews){return reviews.flatMap(r=>(r.kpis||[{}]).map(k=>{
 const original=r.original_results?.[k.name]||{},review=r.review_results?.[k.name]||{};
 return [r.day,r.external_id,studyLabel(r.study),r.country,r.validator_name,r.original_completed_at,r.original_sla_seconds,r.analyst_name,r.assigned_at,r.status,
  r.started_at,r.completed_at,r.on_time?'Sí':r.status==='completed'?'No':'Pendiente',verdictLabel(r.verdict),k.name||'',decisionLabel(original.status),original.tipificacion,
  review.evaluation,review.correct_decision,review.comment,r.selection,reasons(r)];
}));}
export const exportHeaders=['Día de validación original','ID auditoría','Estudio','País','Validador original','Fin validación original','SLA original (seg)','Analista PQR','Asignación PQR','Estado PQR',
 'Inicio revisión PQR','Fin revisión PQR','Revisada el mismo día','Resultado PQR','Alerta','Respuesta original','Tipificación original','Evaluación PQR','Respuesta correcta','Observación PQR','Selección','Motivos de prioridad'];
