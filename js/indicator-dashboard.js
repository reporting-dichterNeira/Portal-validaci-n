(function(root) {
  'use strict';
  const M = root.PortalIndicatorMetrics;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => Number(v || 0).toLocaleString('es-CO');
  const pct = v => v == null ? 'Sin base' : (v * 100).toLocaleString('es-CO', {maximumFractionDigits:1}) + '%';
  const decimal = v => v == null ? 'Sin muestras' : v.toLocaleString('es-CO',{maximumFractionDigits:1});
  const normalize = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  function field(a, names) {
    for (const source of [a, a.meta || {}]) for (const name of names) {
      const key = Object.keys(source).find(k => normalize(k) === normalize(name));
      if (key && source[key] !== '' && source[key] != null) return source[key];
    }
    return '';
  }
  function indexedFieldReader() {
    // Index each row once during preparation, rather than normalizing every
    // metadata column again for every alias and every indicator.
    const indexes=new WeakMap(), aliases=new Map();
    return (a,names)=>{
      for(const source of [a,a.meta || {}]) {
        let index=indexes.get(source);
        if(!index) {
          index=new Map();
          for(const key of Object.keys(source)) {const normalized=normalize(key);if(!index.has(normalized))index.set(normalized,key);}
          indexes.set(source,index);
        }
        for(const name of names) {
          if(!aliases.has(name))aliases.set(name,normalize(name));
          const key=index.get(aliases.get(name));
          if(key && source[key]!=='' && source[key]!=null)return source[key];
        }
      }
      return '';
    };
  }
  function canonical(audits) {
    const latestBatches = new Map();
    for (const a of audits || []) {
      const day = a._physicalBatchOperationDate || a._batchOperationDate || a.fecha || '';
      const key = JSON.stringify([a._module,a._studyId || a.estudio,a._countryId,day]);
      latestBatches.set(key, Math.max(latestBatches.get(key) || 0, Number(a._batchId || 0)));
    }
    const map = new Map();
    for (const a of audits || []) {
      if (a._pendingResolution === 'removed' || a._pendingResolution === 'replaced') continue;
      const batchKey = JSON.stringify([a._module,a._studyId || a.estudio,a._countryId,a._physicalBatchOperationDate || a._batchOperationDate || a.fecha || '']);
      if (Number(a._batchId || 0) < latestBatches.get(batchKey)) continue;
      const key = JSON.stringify([a._module || 'blocking',a._studyId || a.estudio,String(a.id)]);
      const prev = map.get(key);
      if (!prev || Number(a._batchId || 0) > Number(prev._batchId || 0) ||
        (Number(a._batchId || 0) === Number(prev._batchId || 0) && a.validationStatus === 'completada' && prev.validationStatus !== 'completada')) map.set(key,a);
    }
    return [...map.values()];
  }
  function adapt(audits, context = [], countryFor = null) {
    const readField=indexedFieldReader();
    const byId = new Map();
    for (const c of context) {
      const id = String(c.audit_external_id || '');
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(c);
    }
    return M.normalizeAudits(canonical(audits).filter(a=> (a._module || 'blocking') === 'blocking' && /^\d+$/.test(String(a.id))).map(a=> {
      const candidates = byId.get(String(a.id)) || [];
      const fallback = names => {
        const values = [...new Set(candidates.map(c=>readField(c,names)).filter(Boolean))];
        return values.length === 1 ? values[0] : '';
      };
      const kpis = (a.kpis || []).filter(k=>k.needsReview === true || k.alertaStatus === 'SE ALERTA').map(k=> {
        const r = a.validationResults?.[k.name] || {};
        return {...k, needsReview:true, decision:r.status, reason:r.tipificacion,
          validatedAt:r.supervisorResolvedAt || r.decisionAt || ''};
      });
      const periodDate = a._originalOperationDate || a._batchOperationDate || a.fecha || '';
      return {id:a.id, study:a.estudio, periodDate,
        auditDate:readField(a,['fechaAuditoriaOriginal','auditDate','Fecha_del_audito','FECHA_AUDITORIA','FECHA_AUDITO','FECHA_AU']) || fallback(['audit_date']),
        alertUploadedAt:a._originalUploadedAt || a._batchUploadedAt || a._createdAt,
        country:countryFor ? countryFor(a) : readField(a.databricksGeography || {},['country']) || readField(a,['pais','country']),
        // Only the Databricks export / verified historical enrichment can
        // identify the field auditor. Never read it from the uploaded base.
        auditor:databricksAuditor(a,candidates,readField),
        pdv:readField(a,['idPDV','pdv']) || fallback(['pdv_id']),
        region:readField(a.databricksGeography || {},['region']) || readField(a,['region']) || fallback(['region']), channel:readField(a,['canal','channel']) || fallback(['channel']),
        subchannel:readField(a,['subcanal','subchannel']) || fallback(['subchannel']), kpis};
    }));
  }
  function databricksAuditor(a, candidates, readField=field) {
    const clean=value=>{
      const text=String(value ?? '').trim();
      return !text || /^auditor\s*\([^)]*\)$/i.test(text) || /^\d+$/.test(text) || /^(sin (auditor|identificar)|n\/?a|null)$/i.test(text) ? '' : text;
    };
    const names=[...new Set(candidates.map(c=>clean(readField(c,['nombre_usuario','auditor']))).filter(Boolean))];
    if(names.length>1)return '';
    if(names.length===1)return names[0];
    const verified=a.databricksGeography;
    return verified?.auditorSource==='storeview.slv_sv_ceres_ag_export.nombre_usuario' ? clean(verified.auditor) : '';
  }
  const row = cells => '<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>';
  function table(headers, rows) {
    return '<div class="table-responsive"><table class="data-table indicator-table"><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+
      (rows.length ? rows.join('') : '<tr><td colspan="'+headers.length+'">Sin registros para este alcance.</td></tr>')+'</tbody></table></div>';
  }
  function panel(title, description, body) {
    const symbols = [['Indicadores','📊'],['Pendientes por','⏳'],['Motivos','🔎'],['Auditores','👥'],['Tiempo','⏱️'],['Tendencia','📈'],['Benchmark','🌎'],['Top alertas','🎯'],['Evolución','⏱️'],['Desempeño','🗺️'],['Distribución','🗂️'],['Definiciones','📖'],['Historial','🧾']];
    const symbol = symbols.find(([prefix])=>title.startsWith(prefix))?.[1];
    return '<section class="glass-panel indicator-panel"><h3 class="indicator-heading">'+(symbol?'<span class="indicator-heading-icon" aria-hidden="true">'+symbol+'</span>':'')+title+'</h3><p class="panel-desc">'+description+'</p>'+body+'</section>';
  }
  function cards(items, variant='') {
    return '<div class="indicator-cards '+(variant?'indicator-cards--'+variant:'')+'">'+items.map(([label,value,hint='',tone='blue',symbol='📊',progress=null],i)=>
      '<div class="stat-card indicator-card indicator-tone-'+tone+'" style="--indicator-order:'+i+'"><div class="indicator-card-main"><span class="stat-icon-wrapper indicator-card-icon" aria-hidden="true">'+symbol+'</span><div class="stat-details"><span class="stat-label">'+label+'</span><strong class="stat-value">'+value+'</strong>'+(hint?'<small>'+hint+'</small>':'')+'</div></div>'+
      (Number.isFinite(progress)?'<div class="indicator-meter" aria-hidden="true"><span style="--indicator-fill:'+Math.max(0,Math.min(100,progress*100))+'%"></span></div>':'')+'</div>').join('')+'</div>';
  }
  function csv(headers, rows) {
    const cell = v => {let s=String(v ?? '');if(typeof v==='string' && /^[=+\-@\t\r]/.test(s)) s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    return '\uFEFF'+[headers,...rows].map(r=>r.map(cell).join(';')).join('\r\n');
  }
  function download(headers, rows, name) {
    if (!rows.length) return;
    const url = URL.createObjectURL(new Blob([csv(headers,rows)],{type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function time(t) { return (t.meanDays == null ? 'Sin muestras' : decimal(t.meanDays)+' días')+' · '+num(t.measured)+' muestras'+
    (t.exact ? '<br>'+decimal(t.meanHours)+' horas · '+num(t.exact)+' con hora exacta' : '')+
    '<br><small>Sin fecha: '+num(t.missing)+' · Inválidas: '+num(t.invalid)+' · Futuras: '+num(t.future)+'</small>'; }
  function universe(app,state,executive) {
    const studyName=s=>M.normalizeAudits([{id:'1',study:s,kpis:[]}])[0]?.study;
    const studies=(app.selectedStudies||['ALL']).includes('ALL')?[]:(app.selectedStudies||[]).map(studyName);
    const filters={studies,month:executive?state.month:'',from:app.visualizationDateFrom||'',to:app.visualizationDateTo||'',geography:app.selectedReportCountry||'all',region:state.region,channel:state.channel,subchannel:state.subchannel};
    const key=JSON.stringify([app.currentProfile?.id,filters]);
    app.databricksTotalsCache ||= new Map();
    let entry=app.databricksTotalsCache.get(key);
    if(!entry||Date.now()-entry.loadedAt>5*60*1000) {
      entry={loading:true,data:null,error:'',loadedAt:Date.now()};app.databricksTotalsCache.set(key,entry);
      if(app.databricksTotalsCache.size>12)app.databricksTotalsCache.delete(app.databricksTotalsCache.keys().next().value);
      if(app.backend?.loadDatabricksAuditTotals)app.backend.loadDatabricksAuditTotals(filters).then(data=>entry.data=data).catch(error=>entry.error=error.message).finally(()=>{entry.loading=false;if(app.currentView==='visualizations')app.renderReportsView();});
      else {entry.loading=false;entry.error='Fuente no disponible';}
    }
    const rows=entry.data?.studies||[],names=studies.length?studies:['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley'];
    const supported=new Set(['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley']);
    const snapshots=(entry.data?.snapshots||[]).filter(s=>/^Databricks/i.test(s.source)),verified=snapshots.length>0;
    const partial=names.some(n=>!supported.has(n)&&!rows.some(r=>r.study_name===n));
    const total=entry.data&&snapshots.some(s=>/^Databricks/i.test(s.source))&&names.some(n=>supported.has(n))?rows.reduce((n,r)=>n+Number(r.databricks_total||0),0):null;
    return {entry,rows,names,verified,partial,total,snapshots};
  }
  function universePanel(u,result) {
    const unavailable=u.entry.error?'Error al consultar':'Sin corte conectado';
    const value=u.total===null?(u.entry.loading?'Consultando…':unavailable):num(u.total)+(u.partial?' *':'');
    return panel('🌐 Universo de auditorías y casos en el portal','Son bases distintas: Databricks cuenta todas las auditorías del export, en cualquier estado; el sistema cuenta las auditorías con alertas cargadas al módulo Bloqueantes.',cards([
      ['Auditorías totales · Databricks',value,'Cortes sincronizados de Databricks · IDs únicos por estudio','cyan','🌐'],
      ['Auditorías recibidas · sistema',num(result.audits),'Casos cargados al portal, no el universo de campo','blue','🏬']
    ])+table(['Estudio','Total Databricks','Recibidas en alertas'],u.names.map(name=>{
      const r=u.rows.find(r=>r.study_name===name);
      const known=u.snapshots.some(s=>/^Databricks/i.test(s.source))&&['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley'].includes(name);
      return row([esc(name),u.entry.loading?'Consultando…':u.entry.error?unavailable:known&&r?num(r.databricks_total):known?'0':unavailable,num(result.auditCountsByStudy?.[name]||0)]);
    }))+'<p class="story-note">Databricks usa el mes de Ola y, si se filtran días, la fecha original de auditoría. El portal usa la jornada de carga. No se calcula una cobertura entre cohortes distintas. '+(u.snapshots.length?'Cortes: '+u.snapshots.map(s=>esc(String(s.month).slice(0,7))+' · '+esc(s.refreshed_at)).join('; '):'La ausencia de un corte o un error de consulta no se interpreta como cero.')+'</p>'+(u.entry.error?'<p role="alert">No fue posible consultar Databricks: '+esc(u.entry.error)+'</p>':'')+'<button type="button" class="btn btn-outline btn-sm" data-universe-refresh>↻ Actualizar totales</button>');
  }
  const journey = [
    ['summary','📊','Resumen','¿Cómo va la operación?'],
    ['pending','⏳','Pendientes','¿Qué falta por revisar?'],
    ['findings','🔎','Hallazgos','¿Qué confirmó la revisión?'],
    ['comparison','🌎','Comparativas','¿Dónde se concentra?'],
    ['timing','⏱️','Tiempos','¿Cuánto tarda cada paso?'],
    ['detail','📥','Detalle y descargas','Consultar fuentes y reportes']
  ];
  const committeeJourney = [
    ['summary','👔','Resumen para dirección','Volumen, revisión y resultado'],
    ['focus','🌎','Focos de atención','Dónde enfocar la gestión'],
    ['evolution','📈','Evolución','Qué cambia entre meses'],
    ['decisions','🎯','Decisiones propuestas','Qué llevar a la mesa'],
    ['detail','📥','Detalle operativo','Fuentes, pendientes y descargas']
  ];
  function committeeData(result, range, history, month, filters) {
    const inherited=M.compute(history.filter(a=>a.month && a.month<month),{...filters,from:'',to:filters.asOf,month:''});
    const scopes=new Map();
    for(const a of range.alerts.filter(a=>a.month<=month)) {
      if(!scopes.has(a.month))scopes.set(a.month,[]);
      scopes.get(a.month).push(a);
    }
    const trend=[...scopes].sort(([a],[b])=>a.localeCompare(b)).slice(-6).map(([m,alerts])=>{
      const counts=M.totals(alerts),decided=counts.applies+counts.rejects;
      return {month:m,...counts,decided,confirmation:decided?counts.applies/decided:null,
        discard:decided?counts.rejects/decided:null,
        partial:range.monthly.filter(r=>r.month===m).some(r=>r.partial)};
    });
    for(let i=0;i<trend.length;i++) {
      const r=trend[i],p=trend[i-1],d=new Date(r.month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);
      r.change=p && !p.partial && !r.partial && p.month===d.toISOString().slice(0,7) && p.total ? (r.total-p.total)/p.total : null;
    }
    return {inherited,trend,timing:range.timing.monthly.filter(r=>r.month<=month).slice(-6),focus:[...result.benchmark].filter(r=>r.pending).sort((a,b)=>b.pending-a.pending||b.total-a.total||a.study.localeCompare(b.study)).slice(0,3)};
  }
  function inheritedPanel(data, month, asOf) {
    const r=data.inherited,s=story(r);
    return '<aside class="glass-panel committee-carryover"><div><span class="corporate-badge">⏳ PENDIENTES HEREDADOS · FUERA DEL TOTAL DEL MES</span><h3>'+num(r.counts.pending)+' alertas en '+num(s.pendingAudits)+' auditorías</h3><p>Jornadas anteriores a '+esc(month || 'la selección')+' que siguen pendientes al '+esc(asOf)+'. Respeta estudio, país / región y filtros adicionales; ignora el rango de fechas para no ocultar el rezago.</p><small>Estado actual, no una fotografía del cierre histórico. '+num(r.backlog.old.length)+' auditorías con 15 días o más; '+num(r.backlog.missing.length)+' sin fecha original.</small></div><button type="button" class="btn btn-outline btn-sm" data-story-section="detail">Ver detalle →</button></aside>';
  }
  function committeeSection(section,result,data,month,partial) {
    const c=result.counts,s=story(result),macro=macroData(result);
    const jump=(id,label)=>'<button type="button" class="btn btn-outline btn-sm" data-story-section="'+id+'">'+label+' →</button>';
    if(section==='summary') {
      const label=month?new Date(month+'-15T12:00:00Z').toLocaleDateString('es-CO',{month:'long',year:'numeric',timeZone:'America/Bogota'}):'Sin mes disponible';
      return '<section class="glass-panel committee-lead"><div><span class="corporate-badge">👔 LECTURA PARA DIRECCIÓN · BLOQUEANTES</span><h2>'+esc(label)+'</h2><p>'+esc(s.headline)+'</p></div><span class="committee-cut">'+(partial?'📅 Corte parcial del mes':'📅 Período mensual seleccionado')+'</span></section>'+cards([
        ['Auditorías recibidas · sistema',num(result.audits),'IDs únicos cargados al portal en el mes','blue','🏬'],
        ['Alertas recibidas',num(c.total),'Alertas de la cohorte mensual','purple','📥'],
        ['Cobertura de revisión',pct(c.coverage),num(s.decided)+' revisadas / '+num(c.total)+' recibidas','cyan','🔎',c.coverage],
        ['Confirmadas · Aplica',num(c.applies),pct(s.confirmation)+' de las revisadas','green','✅'],
        ['Descartadas · No aplica',num(c.rejects),pct(s.decided?c.rejects/s.decided:null)+' de las revisadas','magenta','✋'],
        ['Pendientes del mes',num(c.pending),num(s.pendingAudits)+' auditorías con alguna pendiente','orange','⏳']
      ],'macro')+panel('📊 Qué nos dicen los resultados','Misma cohorte mensual y filtros; decisiones conocidas al día de consulta.',decisionBar(c)+'<p class="story-note">Recibidas = Aplica + No aplica + pendientes. Cobertura = revisadas / recibidas. Confirmación y descarte en las tarjetas = resultado / revisadas. No aplica no significa editar una auditoría.</p>')+
      '<div class="committee-grid">'+panel('🌎 Dónde concentrar la gestión','Prioridad por volumen de pendientes, no un ranking de desempeño.',data.focus.length?'<ol class="committee-top">'+data.focus.map((r,i)=>'<li><span class="committee-rank">'+(i+1)+'</span><div><strong>'+esc(r.study)+' · '+esc(r.geography)+'</strong><small>'+num(r.pending)+' pendientes · '+pct(c.pending?r.pending/c.pending:null)+' de los pendientes del mes · '+pct(r.coverage)+' de cobertura</small></div></li>').join('')+'</ol>'+jump('focus','Ver focos y contexto'):'<p class="indicator-empty">'+(c.total?'Sin pendientes en el mes seleccionado.':'Sin datos para establecer prioridades.')+'</p>')+
      panel('🎯 Mensaje para el comité','Hechos observados, sin metas ni conclusiones comerciales inventadas.','<p class="committee-message">'+(c.total?'Se revisaron <b>'+pct(c.coverage)+'</b> de las alertas recibidas. '+(s.decided?'De las revisadas, <b>'+pct(s.confirmation)+'</b> se confirmaron. ':'Aún no hay decisiones para evaluar la confirmación. ')+(c.pending?'La lectura sigue abierta: faltan <b>'+num(c.pending)+'</b> decisiones.':'Todas tienen una decisión registrada.'):'No hay alertas para evaluar en esta selección.')+'</p><p class="story-note">Más alertas no implica peor ejecución: puede reflejar más auditorías o mayor detección. Esta vista no mide ahorro, ventas ni retorno financiero.</p>'+jump('decisions','Preparar decisiones'))+'</div>';
    }
    if(section==='focus') return panel('🌎 Dónde enfocar la gerencia','Mes seleccionado. País en KO Tradicional / KO Moderno; región en Chile / Lindley. Lee la confirmación junto a cobertura y tamaño de muestra.',
      '<div class="committee-studies">'+macro.studies.map(r=>'<article><h4>'+esc(r.study)+'</h4><strong>'+num(r.total)+' alertas</strong>'+decisionBar(r)+'<small>'+num(r.audits)+' auditorías con alertas · Cobertura '+pct(r.coverage)+'</small><details><summary>Ver países / regiones</summary>'+table(['Territorio','Recibidas','Revisadas','Aplica','No aplica','Pendientes','Cobertura','Confirmación'],result.benchmark.filter(b=>b.study===r.study).sort((a,b)=>b.pending-a.pending).map(b=>row([esc(b.geography),num(b.total),num(b.applies+b.rejects),num(b.applies),num(b.rejects),num(b.pending),pct(b.coverage),pct(b.applies+b.rejects?b.applies/(b.applies+b.rejects):null)])))+'</details></article>').join('')+'</div>'+(c.total?'':'<p class="indicator-empty">Sin estudios con alertas en esta selección.</p>'))+
      panel('🔎 Qué está generando las alertas','Top 3 por volumen recibido, no por errores confirmados.',table(['Variable','Recibidas','Aplica','No aplica','Pendientes','Cobertura'],macro.variables.slice(0,3).map(r=>row([esc(r.name),num(r.total),num(r.applies),num(r.rejects),num(r.pending),pct(r.coverage)]))))+
      panel('✋ Motivos principales de descarte','Top 3; participación sobre No aplica. Los faltantes permanecen visibles.',table(['Motivo','Descartadas','% de descartadas'],result.reasons.slice(0,3).map(r=>row([esc(r.name),num(r.count),pct(r.share)]))));
    if(section==='evolution') {
      const max=Math.max(1,...data.trend.map(r=>r.total));
      return panel('📈 Volumen y avance de la revisión','Hasta seis meses con datos dentro del rango general, hasta el mes seleccionado. Son cohortes de jornada con decisiones actuales; no productividad ni cierres históricos.',
        '<div class="committee-trend">'+data.trend.map(r=>'<article><strong>'+esc(r.month)+(r.partial?' · Parcial':'')+'</strong><div class="committee-trend-bars" aria-hidden="true"><span style="width:'+r.total/max*100+'%"></span><i style="width:'+r.decided/max*100+'%"></i></div><small>'+num(r.total)+' recibidas · '+num(r.decided)+' revisadas · '+pct(r.coverage)+' cobertura</small></article>').join('')+'</div><p class="story-note">Azul: recibidas. Verde: revisadas. Una misma escala de volumen para todos los meses. Los meses sin registros no se representan como cero.</p>'+table(['Mes de jornada','Recibidas','Revisadas','Cobertura','Confirmación¹','Descarte¹','Pendientes','Cambio de volumen'],data.trend.map(r=>row([esc(r.month)+(r.partial?' · Parcial':''),num(r.total),num(r.decided),pct(r.coverage),pct(r.confirmation),pct(r.discard),num(r.pending),r.change==null?'No comparable':pct(r.change)])))+'<p class="story-note">¹ Sobre las revisadas. Solo se calcula cambio entre meses completos consecutivos. No se compara un mes parcial con uno completo; la cobertura puede cambiar al resolver pendientes antiguos.</p>')+
        panel('⏱️ Tiempos de la cohorte seleccionada','Promedios sin meta aprobada. Muestras y fechas faltantes se muestran para no confundir ausencia de información con rapidez.',cards([
          ['Auditoría → carga',time(result.timing.intake),'Una muestra por auditoría','blue','📤'],
          ['Carga → decisión',time(result.timing.validation),'Una muestra por alerta decidida','purple','⏱️']
        ],'timing')+'<p class="story-note">No es un SLA. La cohorte usa jornada; los intervalos usan las fechas reales de auditoría, carga y decisión.</p>')+
        panel('⏱️ Evolución de los tiempos de respuesta','Auditorías dentro del rango general, agrupadas aquí por el mes real de carga. Por eso no equivale necesariamente a la cohorte de jornada.',table(['Mes real de carga','Auditoría → carga','Carga → decisión'],data.timing.map(r=>row([esc(r.month),time(r.intake),time(r.validation)]))));
    }
    if(section==='decisions') {
      const proposals=[];
      if(c.pending)proposals.push(['Priorizar la revisión del mes',num(c.pending)+' alertas sin decisión; '+num(result.backlog.old.length)+' auditorías pendientes con 15 días o más.','Acordar capacidad y orden de revisión con supervisión.']);
      if(data.inherited.counts.pending)proposals.push(['Resolver el rezago heredado',num(data.inherited.counts.pending)+' alertas anteriores al mes siguen pendientes hoy.','Pedir al supervisor revisar la base y decidir descarga, reasignación o retiro justificado.']);
      if(c.rejects)proposals.push(['Revisar las causas de descarte',num(c.rejects)+' No aplica; '+(result.reasons[0]?esc(result.reasons[0].name)+' es el motivo de mayor volumen.':''),'Revisar reglas y evidencias con calidad antes de proponer cambios en las alertas.']);
      if(result.missingCountries||result.backlog.missing.length)proposals.push(['Completar el contexto faltante',num(result.missingCountries)+' auditorías sin país; '+num(result.backlog.missing.length)+' pendientes sin fecha original.','Verificar los cruces y las fechas en las fuentes; no inferir información ausente.']);
      return panel('🎯 Decisiones para discutir','Sugerencias a partir de los datos, no acciones ejecutadas ni compromisos ya acordados.',proposals.length?'<div class="committee-proposals">'+proposals.map(([title,evidence,action],i)=>'<article><span class="corporate-badge">PROPUESTA '+(i+1)+'</span><h4>'+title+'</h4><p><b>Hecho observado:</b> '+evidence+'</p><p><b>Acción sugerida:</b> '+action+'</p><small>Responsable y fecha objetivo: por acordar en comité.</small></article>').join('')+'</div>':'<p class="indicator-empty">'+(c.total?'No se identificaron pendientes o descartes que generen propuestas automáticas. Esto no sustituye la revisión gerencial.':'Sin datos suficientes para proponer acciones.')+'</p>')+panel('📌 Qué no debe concluirse aún','Límites de esta lectura ejecutiva.','<p class="story-note">No hay metas aprobadas para calificar cumplimiento, ni datos suficientes para atribuir ahorro, ventas o impacto financiero. Mayor volumen o mayor descarte no demuestra por sí solo peor desempeño.</p>');
    }
    return '';
  }
  function story(result) {
    const c=result.counts, decided=c.applies+c.rejects;
    const pendingAudits=Object.values(result.backlog).reduce((n,rows)=>n+rows.length,0);
    const headline=!c.total ? 'Sin alertas en esta selección' : c.pending ?
      num(decided)+' de '+num(c.total)+' alertas ya tienen decisión; quedan '+num(c.pending)+' por revisar.' :
      'Todas las '+num(c.total)+' alertas de esta selección tienen decisión.';
    return {headline,pendingAudits,decided,confirmation:decided?c.applies/decided:null};
  }
  function decisionBar(c) {
    if(!c.total)return '<p class="indicator-empty">No hay una base de alertas para calcular porcentajes.</p>';
    const parts=[['Confirmadas · Aplica',c.applies,'green'],['Descartadas · No aplica',c.rejects,'magenta'],['Sin decisión',c.pending,'orange']];
    return '<div class="story-distribution" aria-hidden="true">'+parts.map(([,n,tone])=>'<span class="indicator-tone-'+tone+'" style="width:'+n/c.total*100+'%;background:var(--indicator-accent)"></span>').join('')+'</div><div class="story-legend">'+parts.map(([label,n,tone])=>'<span class="indicator-tone-'+tone+'"><i aria-hidden="true"></i>'+label+' <strong>'+num(n)+'</strong> · '+pct(n/c.total)+'</span>').join('')+'</div>';
  }
  function macroData(result) {
    const studies=new Map(), variables=new Map();
    for(const a of result.alerts){
      if(!studies.has(a.study))studies.set(a.study,{study:a.study,ids:new Set(),alerts:[]});
      const s=studies.get(a.study);s.ids.add(a.id);s.alerts.push(a);
      if(!variables.has(a.name))variables.set(a.name,[]);
      variables.get(a.name).push(a);
    }
    return {
      studies:[...studies.values()].map(s=>({study:s.study,audits:s.ids.size,...M.totals(s.alerts)})).sort((a,b)=>b.total-a.total||a.study.localeCompare(b.study)),
      variables:[...variables].map(([name,alerts])=>({name,...M.totals(alerts)})).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name))
    };
  }
  function macroDashboard(result, month, partial) {
    const c=result.counts, s=story(result), macro=macroData(result);
    const focus=macro.studies.filter(r=>r.pending).sort((a,b)=>b.pending-a.pending)[0];
    const monthLabel=month?new Date(month+'-15T12:00:00Z').toLocaleDateString('es-CO',{month:'long',year:'numeric',timeZone:'America/Bogota'}):'Sin mes disponible';
    const link=(section,label)=>'<button type="button" class="btn btn-outline btn-sm" data-story-section="'+section+'">'+label+' →</button>';
    let html='<section class="glass-panel committee-lead"><div><span class="corporate-badge">👔 DASHBOARD MENSUAL · BLOQUEANTES</span><h2>'+esc(monthLabel)+'</h2><p>'+esc(s.headline)+'</p></div><span class="committee-cut">'+(partial?'📅 Corte parcial del mes':'📅 Período mensual seleccionado')+'</span></section>';
    html+=cards([
      ['Auditorías del mes',num(result.audits),'IDs únicos por estudio · '+num(macro.studies.length)+' estudios con alertas','blue','🏬'],
      ['Alertas recibidas',num(c.total),'Sub-KPIs que requieren revisión','purple','📥'],
      ['Cobertura de revisión',pct(c.coverage),num(s.decided)+' de '+num(c.total)+' alertas decididas','cyan','🔎',c.coverage],
      ['Confirmación de alertas',pct(s.confirmation),num(c.applies)+' Aplica / '+num(s.decided)+' revisadas','green','✅',s.confirmation],
      ['Alertas descartadas',num(c.rejects),pct(c.rejection)+' de las recibidas · No aplica','magenta','✋'],
      ['Alertas pendientes',num(c.pending),num(s.pendingAudits)+' auditorías con alguna pendiente','orange','⏳']
    ],'macro');
    html+='<div class="committee-grid">'+panel('Resultado global del mes','Base: todas las alertas recibidas del mes y filtros seleccionados.',decisionBar(c)+'<p class="story-note">Aplica + No aplica + pendientes = recibidas. La confirmación de la tarjeta superior usa solo las revisadas. No aplica no implica editar una auditoría.</p>')+
      panel('Prioridad para el comité','Focos derivados del mes seleccionado, sin metas ni semáforos arbitrarios.',
        '<div class="committee-priority"><strong>'+(focus?esc(focus.study)+' concentra '+pct(focus.pending/c.pending)+' de los pendientes':c.total?'Sin alertas pendientes en este alcance':'Sin datos para establecer una prioridad')+'</strong><p>'+(focus?num(focus.pending)+' de '+num(c.pending)+' alertas pendientes del mes.':'')+'</p><p><b>'+num(result.backlog.old.length)+'</b> auditorías pendientes con 15 días o más desde su fecha original.<br><b>'+num(result.backlog.missing.length)+'</b> sin fecha original para medir antigüedad.</p>'+link('pending','Revisar pendientes')+'</div>')+'</div>';
    html+=panel('Comparativa macro por estudio','Mismo mes y filtros. Las barras muestran la composición de cada estudio; los totales permiten comparar volumen. Auditorías: IDs que tienen al menos una alerta.',
      '<div class="committee-studies">'+(macro.studies.length?macro.studies.map(r=>'<article><div class="committee-study-title"><h4>'+esc(r.study)+'</h4><span>'+num(r.total)+' alertas · '+num(r.audits)+' auditorías</span></div>'+decisionBar(r)+'<small>Cobertura: <b>'+pct(r.coverage)+'</b> · Participación en las alertas del mes: <b>'+pct(r.total/c.total)+'</b></small></article>').join(''):'<p class="indicator-empty">Sin estudios con alertas en este mes.</p>')+'</div>'+link('comparison','Ver países, regiones y canales'));
    const top=(items,countKey,total)=>items.slice(0,3).map((r,i)=>'<li><span class="committee-rank">'+(i+1)+'</span><div><strong>'+esc(r.name)+'</strong><small>'+num(r[countKey])+' alertas · '+pct(total?r[countKey]/total:null)+'</small></div></li>').join('') || '<li class="indicator-empty">Sin registros para este mes.</li>';
    html+='<div class="committee-grid">'+panel('Qué variables concentran las alertas','Top 3 por volumen recibido. Una alerta no equivale a un error confirmado.','<ol class="committee-top">'+top(macro.variables,'total',c.total)+'</ol>'+link('findings','Explorar hallazgos'))+
      panel('Por qué se descartaron','Top 3 motivos de No aplica; porcentaje sobre las descartadas. Los faltantes se identifican como Sin tipificación.','<ol class="committee-top">'+top(result.reasons,'count',c.rejects)+'</ol>'+link('findings','Ver motivos'))+'</div>';
    html+=panel('Tiempo de respuesta del mes','Cohorte: auditorías cargadas en el mes seleccionado. Promedios, no plazos comprometidos. Se excluyen intervalos inválidos o sin fechas.',cards([
      ['Auditoría → carga',time(result.timing.intake),'Una muestra por auditoría','blue','📤'],
      ['Carga → decisión',time(result.timing.validation),'Una muestra por alerta decidida','purple','⏱️']
    ],'timing')+link('timing','Ver detalle de tiempos'));
    return html;
  }
  function render(app, audits, historyAudits = null, prepared = null) {
    if (!M || !root.document) return;
    const executive = app.reportsSubtab === 'executive' || app.visualizationTab === 'committee';
    const target = document.getElementById(executive ? 'indicators-executive' : 'indicators-operational');
    if (!target) return;
    if (app.currentView !== 'visualizations' && app.currentTab !== 'reports') return;
    const module = app.currentView === 'visualizations' ? app.getVisualizationModuleFilter() : app.currentModule;
    const legacy=Array.from(target.parentElement.children).filter(el=>el!==target);
    if (module === 'smart') {target.innerHTML=''; legacy.forEach(el=>el.classList.remove('indicator-legacy-hidden')); return;}
    const state = app.indicatorFilters ||= {region:'all',channel:'all',subchannel:'all',month:''};
    // Navigation shares this snapshot. A fresh application render after a
    // load/live update always prepares a new one, including in-place edits.
    const context=prepared?null:[...(app.adminExternalAnalysis?.alertRecords || []),...(app.benchmarkCountryRows || [])];
    const snapshot=prepared || {inputs:adapt(audits,context,a=>app.getReportCountry(a)),calculations:new Map()};
    const inputs=snapshot.inputs;
    if(executive && historyAudits && !snapshot.historyInputs)snapshot.historyInputs=historyAudits===audits ? inputs : adapt(historyAudits,context,a=>app.getReportCountry(a));
    const historyInputs=snapshot.historyInputs || inputs;
    const asOf = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const dimensions = [['region','Región','Sin región'],['channel','Canal','Sin canal'],['subchannel','Subcanal','Sin subcanal']];
    let controls = dimensions.map(([key,label,missing])=> {
      const values=[...new Set(inputs.map(a=>a[key] || missing))].sort();
      if(state[key]!=='all'&&!values.includes(state[key]))state[key]='all';
      return '<label>'+label+'<select class="form-control" data-indicator-filter="'+key+'"><option value="all">Todas</option>'+values.map(v=>'<option value="'+esc(v)+'" '+(v===state[key]?'selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label>';
    }).join('');
    const months=[...new Set(inputs.map(a=>a.month).filter(Boolean))].sort();
    if(!months.includes(state.month))state.month=months.at(-1) || '';
    const monthControl=executive?'<label>📅 Mes del comité<select class="form-control" data-indicator-filter="month" '+(!months.length?'disabled':'')+'>'+(months.length?months.map(m=>'<option '+(m===state.month?'selected':'')+'>'+m+'</option>').join(''):'<option>Sin meses disponibles</option>')+'</select></label>':'';
    const firstDate=inputs.map(a=>a.periodDate).filter(Boolean).sort()[0] || '';
    const from=app.visualizationDateFrom || (executive && firstDate ? firstDate.slice(0,7)+'-01' : firstDate);
    const to=app.visualizationDateTo || asOf;
    const calculationKey=JSON.stringify([executive,state.region,state.channel,state.subchannel,state.month,from,to,asOf]);
    let calculated=snapshot.calculations.get(calculationKey);
    if(!calculated) {
      const rangeResult=M.compute(inputs,{...state,asOf,from,to,month:executive?state.month:''});
      const result=executive ? M.compute(inputs.filter(a=>a.month===state.month),{...state,asOf,from,to,month:state.month}) : rangeResult;
      calculated={rangeResult,result,committee:executive?committeeData(result,rangeResult,historyInputs,state.month,{...state,asOf}):null};
      // Bound retained cohorts while allowing fast back-and-forth navigation.
      if(snapshot.calculations.size>=2)snapshot.calculations.delete(snapshot.calculations.keys().next().value);
      snapshot.calculations.set(calculationKey,calculated);
    }
    const {rangeResult,result}=calculated;
    const c=result.counts, narrative=story(result);
    const sectionKey=executive?'indicatorExecutiveSection':'indicatorOperationalSection';
    const navigation=executive?committeeJourney:journey;
    const section=navigation.some(([id])=>id===app[sectionKey])?app[sectionKey]:'summary';
    legacy.forEach(el=>el.classList.toggle('indicator-legacy-hidden',section!=='detail'));
    const scope=executive?'Mes de jornada: '+(state.month || 'Sin datos'):'Jornadas: '+(from || 'Sin fecha')+' a '+to;
    const jump=(id,text)=>'<button type="button" class="btn btn-outline btn-sm" data-story-section="'+id+'">'+text+' →</button>';
    let html='<section class="glass-panel story-header"><div><span class="corporate-badge">'+(executive?'LECTURA PARA DIRECCIÓN':'LECTURA DE LA OPERACIÓN')+' · BLOQUEANTES</span><h2>'+ (executive?'Dashboard general del comité':'Panorama de la operación')+'</h2><p>'+(executive?'Del resultado del mes a las decisiones: qué revisamos, dónde enfocar la gestión y qué acordar como siguiente paso.':'De la carga de alertas a la decisión: primero el estado general, después las prioridades y sus causas.')+'</p></div><div class="story-scope">'+monthControl+esc(scope)+'<small>Estudios, país / región y fechas según los filtros del portal. No incluye Smart.</small></div></section>'+
      '<nav class="story-nav'+(executive?' story-nav--committee':'')+'" aria-label="Apartados de indicadores">'+navigation.map(([id,icon,label,question],i)=>'<button type="button" data-story-section="'+id+'" aria-current="'+(id===section?'page':'false')+'"><span aria-hidden="true">'+icon+'</span><strong>'+(i+1)+'. '+label+'</strong><small>'+question+'</small></button>').join('')+'</nav>'+
      '<details class="glass-panel story-filters" '+(state.region!=='all'||state.channel!=='all'||state.subchannel!=='all'?'open':'')+'><summary>🔍 Afinar esta lectura'+(executive?' · Mes '+esc(state.month):'')+' · Región: '+esc(state.region==='all'?'Todas':state.region)+' · Canal: '+esc(state.channel==='all'?'Todos':state.channel)+' · Subcanal: '+esc(state.subchannel==='all'?'Todos':state.subchannel)+'</summary><div class="indicator-controls">'+controls+'</div><p>Estos filtros adicionales aplican a los '+(executive?'cinco':'seis')+' apartados y su CSV; no cambian los reportes clásicos.</p></details>';
    let committee;
    if(section==='summary')html+=universePanel(universe(app,state,executive),result);
    if(executive) {
      const monthStart=state.month+'-01';
      const monthEnd=state.month?new Date(Date.UTC(Number(state.month.slice(0,4)),Number(state.month.slice(5,7)),0)).toISOString().slice(0,10):'';
      committee=calculated.committee;
      html+=committeeSection(section,result,committee,state.month,!!monthEnd&&((app.visualizationDateFrom && app.visualizationDateFrom>monthStart) || to<monthEnd || asOf<monthEnd));
      html+=inheritedPanel(committee,state.month,asOf);
      if(section==='detail')html+=panel('⏳ Detalle del rezago heredado','Hasta 100 auditorías que siguen pendientes hoy, de jornadas anteriores al mes seleccionado. El CSV incluye todas.',
        '<button type="button" class="btn btn-outline btn-sm" data-committee-inherited '+(!committee.inherited.counts.pending?'disabled':'')+'>📥 Descargar pendientes heredados (CSV)</button>'+table(['ID','Jornada original','Estudio','País / región','Alertas pendientes'],Object.values(committee.inherited.backlog).flat().slice(0,100).map(a=>row([esc(a.id),esc(a.periodDate),esc(a.study),esc(a.geography),num(a.pending)]))));
    }
    if(section==='summary' && !executive) {
      html+=panel('La operación en una mirada',esc(narrative.headline),cards([
        ['Auditorías recibidas · sistema',num(result.audits),'IDs únicos cargados al portal','blue','🏬'],
        ['Alertas recibidas',num(c.total),'Sub-KPIs que requieren revisión','purple','📥'],
        ['Alertas revisadas',num(narrative.decided),pct(c.coverage)+' del total recibido','green','✅',c.coverage],
        ['Alertas pendientes',num(c.pending),num(narrative.pendingAudits)+' auditorías con alguna alerta pendiente','orange','⏳']
      ])+decisionBar(c)+'<p class="story-note">Una auditoría puede contener varias alertas. Revisadas = Aplica + No aplica. Recibidas = revisadas + pendientes.</p>');
      html+=panel('Qué significa y dónde actuar','Lectura basada en los datos seleccionados; no se presume una meta ni un plazo aprobado.',
        '<div class="story-actions"><article><span>⏳ PRIORIDAD DE REVISIÓN</span><h4>'+ (c.pending?num(c.pending)+' alertas esperan decisión':'Sin alertas pendientes en esta selección')+'</h4><p>'+num(result.backlog.old.length)+' auditorías pendientes tienen 15 días o más desde la auditoría original. '+num(result.backlog.missing.length)+' no tienen fecha original para calcular su antigüedad.</p>'+jump('pending','Ver pendientes')+'</article><article><span>🔎 RESULTADO DE LA REVISIÓN</span><h4>'+num(c.applies)+' confirmadas · '+num(c.rejects)+' descartadas</h4><p>'+ (narrative.decided?pct(narrative.confirmation)+' de las alertas revisadas fueron confirmadas.':'Aún no hay decisiones para evaluar la confirmación.')+' No aplica significa descartar la alerta; no implica editar la auditoría.</p>'+jump('findings','Entender los hallazgos')+'</article><article><span>🌎 FOCO DE GESTIÓN</span><h4>Comparar con contexto</h4><p>Consulta el volumen y los pendientes por estudio, país o región. Una tasa aislada no indica mejor desempeño si la revisión está incompleta.</p>'+jump('comparison','Comparar territorios')+'</article></div>');
    }
    if(section==='pending' || executive && section==='detail') {
      html+=panel('Qué falta por revisar',num(c.pending)+' alertas pendientes en '+num(narrative.pendingAudits)+' auditorías. Los grupos siguientes cuentan auditorías, no alertas.','<p class="story-note">Las cargas reemplazadas y los registros retirados se excluyen. La gestión de descargar, reasignar o retirar pendientes se conserva en el panel de supervisión.</p>');
      const labels={recent:['0–6 días','blue','📅'],week:['7–14 días','orange','⏳'],old:['15 días o más','magenta','🚩'],missing:['Sin fecha original','purple','❔'],future:['Fecha futura','cyan','🗓️']};
      html+=panel('Pendientes por antigüedad','Días calendario desde la fecha original de auditoría, no desde la jornada de carga. Pulsa un grupo para consultar sus IDs.',
        '<div class="indicator-cards indicator-cards--backlog">'+Object.entries(labels).map(([k,[label,tone,symbol]],i)=>'<button type="button" class="stat-card indicator-card indicator-bucket indicator-tone-'+tone+'" style="--indicator-order:'+i+'" data-indicator-bucket="'+k+'" aria-pressed="false"><span class="indicator-card-main"><span class="stat-icon-wrapper indicator-card-icon" aria-hidden="true">'+symbol+'</span><span class="stat-details"><span class="stat-label">'+label+'</span><strong class="stat-value">'+num(result.backlog[k].length)+'</strong><small>Auditorías pendientes</small></span></span><span class="indicator-bucket-link">Ver detalle <span aria-hidden="true">→</span></span></button>').join('')+'</div><div data-indicator-backlog></div>');
    }
    if(section==='findings' || executive && section==='detail') {
      html+=panel('Qué confirmó la revisión','Porcentajes sobre todas las alertas recibidas en este alcance; los pendientes no se interpretan como descartados.',decisionBar(c));
      html+=panel('Motivos de No aplica','Participación sobre las alertas descartadas, no sobre el total recibido. Hasta 15 motivos; el CSV conserva el detalle.',table(['Motivo','Alertas descartadas','% de descartadas'],result.reasons.slice(0,15).map(r=>row([esc(r.name),num(r.count),pct(r.share)]))));
      html+=panel('Top alertas con mayor tasa de rechazo','Hasta 20 variables. No aplica / alertas recibidas; leer siempre junto a volumen, cobertura y pendientes.',table(['Variable','Alertas','No aplica','Rechazo','Cobertura','Pendientes'],result.rejectedTypes.slice(0,20).map(r=>row([esc(r.name),num(r.total),num(r.rejects),pct(r.rejection),pct(r.coverage),num(r.pending)]))));
      html+=panel('Auditores con alertas recurrentes','Auditor de campo: nombre_usuario del Export de Databricks, cruzado por ID de auditoría; no es el validador. Últimas ocho semanas dentro del filtro, desde '+result.startWeek+'. '+num(result.alertsWithoutAuditor)+' alertas sin auditor identificado se excluyen de este ranking. Recurrencia no es productividad ni error confirmado.',table(['Auditor','Estudio','Semanas con alertas','Alertas'],result.recurrence.slice(0,20).map(r=>row([esc(r.auditor),esc(r.study),num(r.weeks)+' / 8',num(r.total)]))));
    }
    if(section==='timing') {
      html+=panel('Tiempo entre cada paso','Bases separadas: una muestra por auditoría para auditoría → carga; una por alerta decidida para carga → decisión. Horas solo con timestamps completos.',cards([['Auditoría → carga',time(result.timing.intake),'','blue','📤'],['Carga → decisión',time(result.timing.validation),'','purple','⏱️']],'timing'));
      html+=panel('Evolución de tiempos por mes de carga','Fechas sin hora se miden en días calendario; no se estima una hora inexistente.',table(['Mes de carga','Auditoría → carga','Carga → decisión'],result.timing.monthly.map(r=>row([r.month,time(r.intake),time(r.validation)]))));
      html+='<p class="story-note">Estos tiempos no son un SLA: aún no hay un plazo objetivo aprobado. Las fechas faltantes, inválidas o futuras se muestran aparte y no se convierten en cero.</p>';
    }
    if(section==='comparison') {
      html+=panel('Benchmark por estudio y territorio',esc(scope)+'. País para KO; región para Chile y Lindley. Incluye pendientes para interpretar las tasas.',table(['Estudio','País / región','Alertas','Aplica','No aplica','Pendientes','Cobertura','Rechazo'],result.benchmark.map(r=>row([esc(r.study),esc(r.geography),num(r.total),num(r.applies),num(r.rejects),num(r.pending),pct(r.coverage),pct(r.rejection)]))));
      html+=panel('Tendencia mensual · rango completo','Esta tabla compara todos los meses del rango de fechas superior, no solo el mes del resumen. La variación de volumen requiere dos meses completos consecutivos.',table(['Mes','Estudio','País / región','Alertas','Cobertura','Rechazo','Variación vs. mes anterior'],rangeResult.monthly.map(r=>row([esc(r.month)+(r.partial?' · Parcial':''),esc(r.study),esc(r.geography),num(r.total),pct(r.coverage),pct(r.rejection),r.change==null?'No comparable':pct(r.change)]))));
      html+=panel('Distribución por región, canal y subcanal','Hasta 40 grupos. La base diaria y Databricks aportan el contexto; los faltantes se muestran sin inferirlos. El CSV conserva el detalle completo.',table(['Estudio','País','Región','Canal','Subcanal','Alertas','Pendientes','Cobertura','Rechazo'],result.workload.slice(0,40).map(r=>row([esc(r.study),esc(r.country),esc(r.region),esc(r.channel),esc(r.subchannel),num(r.total),num(r.pending),pct(r.coverage),pct(r.rejection)]))));
    }
    if(section==='detail') {
    html+=panel('Detalle de esta lectura','El CSV corresponde al alcance, mes y filtros adicionales de estos indicadores. Una fila por alerta.', '<button type="button" class="btn btn-success" data-indicator-download '+(!c.total?'disabled':'')+'>📥 Descargar alertas de esta lectura (CSV)</button>');
    html+=panel('Reportes clásicos y exportaciones','Se conservan a continuación el histórico, las tablas y descargas anteriores. Usan los filtros generales de estudio, país / región, módulo y fecha del portal; no el mes ni los filtros adicionales de esta lectura.', '<p class="story-note">Pueden tener una base distinta: incluyen el módulo seleccionado (también Smart en Consolidado). Por eso sus totales no necesariamente coinciden con el resumen de Bloqueantes.</p>');
    }
    target.innerHTML=html;
    target.querySelector('[data-universe-refresh]')?.addEventListener('click',()=>{app.databricksTotalsCache?.clear();app.renderReportsView();});
    target.querySelectorAll('[data-story-section]').forEach(el=>el.addEventListener('click',()=>{if(el.dataset.storySection===section)return;app[sectionKey]=el.dataset.storySection;if(el.dataset.storySection==='detail')app.renderClassicReports?.(audits);render(app,audits,historyAudits,snapshot);target.querySelector('[aria-current="page"]')?.focus({preventScroll:true});}));
    target.querySelectorAll('[data-indicator-filter]').forEach(el=>el.addEventListener('change',()=>{state[el.dataset.indicatorFilter]=el.value;render(app,audits,historyAudits,snapshot);}));
    target.querySelector('[data-committee-inherited]')?.addEventListener('click',()=>download(['ID auditoría','Jornada original','Estudio','País','Región','Sub-KPI','Estado actual'],committee.inherited.alerts.filter(a=>a.decision==='pendiente').map(a=>[a.id,a.periodDate,a.study,a.country,a.region,a.name,'Pendiente']),'Pendientes-heredados-antes-'+state.month+'.csv'));
    target.querySelectorAll('[data-indicator-bucket]').forEach(el=>el.addEventListener('click',()=>{
      target.querySelectorAll('[data-indicator-bucket]').forEach(button=>button.setAttribute('aria-pressed',String(button===el)));
      target.querySelector('[data-indicator-backlog]').innerHTML=table(['ID auditoría','Fecha original','Estudio','País','Días','Alertas pendientes'],result.backlog[el.dataset.indicatorBucket].slice(0,100).map(a=>row([esc(a.id),esc(a.auditDate || 'Sin fecha'),esc(a.study),esc(a.country),a.age==null?'—':num(a.age),num(a.pending)])))+'<p>Hasta 100 filas; descarga el detalle completo en CSV.</p>';
    }));
    const auditIndex = new Map(inputs.map(a=>[JSON.stringify([a.id,a.study]),a]));
    target.querySelector('[data-indicator-download]')?.addEventListener('click',()=>download(['ID auditoría','Jornada','Fecha auditoría original','Fecha de carga','Fecha de decisión','Estudio','País','Región','Canal','Subcanal','Auditor','Sub-KPI','Decisión','Tipificación'],result.alerts.filter(a=>!executive || a.month===state.month).map(a=>{
      const source=auditIndex.get(JSON.stringify([a.id,a.study]));
      return [a.id,a.periodDate,source?.auditDate,source?.alertUploadedAt,a.validatedAt,a.study,a.country,a.region,a.channel,a.subchannel,a.auditor,a.name,a.decision,a.reason];
    }),'Indicadores-bloqueantes-'+asOf+'.csv'));
  }
  root.PortalIndicators={adapt,canonical,render,csv,download,esc,table,row,panel,story,decisionBar,journey,committeeJourney,committeeData,committeeSection,inheritedPanel,databricksAuditor,macroData,macroDashboard};
  if(typeof module!=='undefined')module.exports=root.PortalIndicators;
})(typeof globalThis!=='undefined'?globalThis:this);
