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
    const byId = new Map();
    for (const c of context) {
      const id = String(c.audit_external_id || '');
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(c);
    }
    return M.normalizeAudits(canonical(audits).filter(a=> (a._module || 'blocking') === 'blocking' && /^\d+$/.test(String(a.id))).map(a=> {
      const candidates = byId.get(String(a.id)) || [];
      const fallback = names => {
        const values = [...new Set(candidates.map(c=>field(c,names)).filter(Boolean))];
        return values.length === 1 ? values[0] : '';
      };
      const kpis = (a.kpis || []).filter(k=>k.needsReview === true || k.alertaStatus === 'SE ALERTA').map(k=> {
        const r = a.validationResults?.[k.name] || {};
        return {...k, needsReview:true, decision:r.status, reason:r.tipificacion,
          validatedAt:r.supervisorResolvedAt || r.decisionAt || ''};
      });
      const periodDate = a._originalOperationDate || a._batchOperationDate || a.fecha || '';
      return {id:a.id, study:a.estudio, periodDate,
        auditDate:field(a,['fechaAuditoriaOriginal','auditDate','Fecha_del_audito','FECHA_AUDITORIA','FECHA_AUDITO','FECHA_AU']) || fallback(['audit_date']),
        alertUploadedAt:a._originalUploadedAt || a._batchUploadedAt || a._createdAt,
        country:countryFor ? countryFor(a) : field(a.databricksGeography || {},['country']) || field(a,['pais','country']),
        auditor:field(a,['usuario','auditor','nombre_usuario']) || fallback(['auditor']),
        pdv:field(a,['idPDV','pdv']) || fallback(['pdv_id']),
        region:field(a.databricksGeography || {},['region']) || field(a,['region']) || fallback(['region']), channel:field(a,['canal','channel']) || fallback(['channel']),
        subchannel:field(a,['subcanal','subchannel']) || fallback(['subchannel']), kpis};
    }));
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
  const journey = [
    ['summary','📊','Resumen','¿Cómo va la operación?'],
    ['pending','⏳','Pendientes','¿Qué falta por revisar?'],
    ['findings','🔎','Hallazgos','¿Qué confirmó la revisión?'],
    ['comparison','🌎','Comparativas','¿Dónde se concentra?'],
    ['timing','⏱️','Tiempos','¿Cuánto tarda cada paso?'],
    ['detail','📥','Detalle y descargas','Consultar fuentes y reportes']
  ];
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
  function render(app, audits) {
    if (!M || !root.document) return;
    const executive = app.reportsSubtab === 'executive' || app.visualizationTab === 'committee';
    const target = document.getElementById(executive ? 'indicators-executive' : 'indicators-operational');
    if (!target) return;
    if (app.currentView !== 'visualizations' && app.currentTab !== 'reports') return;
    const module = app.currentView === 'visualizations' ? app.getVisualizationModuleFilter() : app.currentModule;
    const legacy=Array.from(target.parentElement.children).filter(el=>el!==target);
    if (module === 'smart') {target.innerHTML=''; legacy.forEach(el=>el.classList.remove('indicator-legacy-hidden')); return;}
    const state = app.indicatorFilters ||= {region:'all',channel:'all',subchannel:'all',month:''};
    const inputs = adapt(audits, [...(app.adminExternalAnalysis?.alertRecords || []),...(app.benchmarkCountryRows || [])],a=> {
      return app.getReportCountry(a);
    });
    const asOf = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const dimensions = [['region','Región','Sin región'],['channel','Canal','Sin canal'],['subchannel','Subcanal','Sin subcanal']];
    let controls = dimensions.map(([key,label,missing])=> {
      const values=[...new Set(inputs.map(a=>a[key] || missing))].sort();
      if(state[key]!=='all'&&!values.includes(state[key]))state[key]='all';
      return '<label>'+label+'<select class="form-control" data-indicator-filter="'+key+'"><option value="all">Todas</option>'+values.map(v=>'<option value="'+esc(v)+'" '+(v===state[key]?'selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label>';
    }).join('');
    const months=[...new Set(inputs.map(a=>a.month).filter(Boolean))].sort();
    if(!months.includes(state.month))state.month=months.at(-1) || '';
    if(executive)controls+='<label>Mes del resumen<select class="form-control" data-indicator-filter="month">'+months.map(m=>'<option '+(m===state.month?'selected':'')+'>'+m+'</option>').join('')+'</select></label>';
    const from=app.visualizationDateFrom || inputs.map(a=>a.periodDate).filter(Boolean).sort()[0] || '';
    const to=app.visualizationDateTo || asOf;
    const rangeResult=M.compute(inputs,{...state,asOf,from,to,month:executive?state.month:''});
    // Every chapter uses the same population. Only the explicitly labelled trend spans months.
    const result=executive ? M.compute(inputs.filter(a=>a.month===state.month),{...state,asOf,from,to,month:state.month}) : rangeResult;
    const c=result.counts, narrative=story(result);
    const sectionKey=executive?'indicatorExecutiveSection':'indicatorOperationalSection';
    const section=journey.some(([id])=>id===app[sectionKey])?app[sectionKey]:'summary';
    legacy.forEach(el=>el.classList.toggle('indicator-legacy-hidden',section!=='detail'));
    const scope=executive?'Mes de jornada: '+(state.month || 'Sin datos'):'Jornadas: '+(from || 'Sin fecha')+' a '+to;
    const jump=(id,text)=>'<button type="button" class="btn btn-outline btn-sm" data-story-section="'+id+'">'+text+' →</button>';
    let html='<section class="glass-panel story-header"><div><span class="corporate-badge">LECTURA DE LA OPERACIÓN · BLOQUEANTES</span><h2>'+ (executive?'Resumen para el comité':'Panorama de la operación')+'</h2><p>De la carga de alertas a la decisión: primero el estado general, después las prioridades y sus causas.</p></div><div class="story-scope">'+esc(scope)+'<small>Estudios, país / región y fechas según los filtros del portal. No incluye Smart.</small></div></section>'+
      '<nav class="story-nav" aria-label="Apartados de indicadores">'+journey.map(([id,icon,label,question],i)=>'<button type="button" data-story-section="'+id+'" aria-current="'+(id===section?'page':'false')+'"><span aria-hidden="true">'+icon+'</span><strong>'+(i+1)+'. '+label+'</strong><small>'+question+'</small></button>').join('')+'</nav>'+
      '<details class="glass-panel story-filters" '+(state.region!=='all'||state.channel!=='all'||state.subchannel!=='all'?'open':'')+'><summary>🔍 Afinar esta lectura'+(executive?' · Mes '+esc(state.month):'')+' · Región: '+esc(state.region==='all'?'Todas':state.region)+' · Canal: '+esc(state.channel==='all'?'Todos':state.channel)+' · Subcanal: '+esc(state.subchannel==='all'?'Todos':state.subchannel)+'</summary><div class="indicator-controls">'+controls+'</div><p>Estos filtros adicionales aplican a los seis apartados y su CSV; no cambian los reportes clásicos.</p></details>';
    if(section==='summary') {
      html+=panel('La operación en una mirada',esc(narrative.headline),cards([
        ['Auditorías en alcance',num(result.audits),'IDs únicos por estudio','blue','🏬'],
        ['Alertas recibidas',num(c.total),'Sub-KPIs que requieren revisión','purple','📥'],
        ['Alertas revisadas',num(narrative.decided),pct(c.coverage)+' del total recibido','green','✅',c.coverage],
        ['Alertas pendientes',num(c.pending),num(narrative.pendingAudits)+' auditorías con alguna alerta pendiente','orange','⏳']
      ])+decisionBar(c)+'<p class="story-note">Una auditoría puede contener varias alertas. Revisadas = Aplica + No aplica. Recibidas = revisadas + pendientes.</p>');
      html+=panel('Qué significa y dónde actuar','Lectura basada en los datos seleccionados; no se presume una meta ni un plazo aprobado.',
        '<div class="story-actions"><article><span>⏳ PRIORIDAD DE REVISIÓN</span><h4>'+ (c.pending?num(c.pending)+' alertas esperan decisión':'Sin alertas pendientes en esta selección')+'</h4><p>'+num(result.backlog.old.length)+' auditorías pendientes tienen 15 días o más desde la auditoría original. '+num(result.backlog.missing.length)+' no tienen fecha original para calcular su antigüedad.</p>'+jump('pending','Ver pendientes')+'</article><article><span>🔎 RESULTADO DE LA REVISIÓN</span><h4>'+num(c.applies)+' confirmadas · '+num(c.rejects)+' descartadas</h4><p>'+ (narrative.decided?pct(narrative.confirmation)+' de las alertas revisadas fueron confirmadas.':'Aún no hay decisiones para evaluar la confirmación.')+' No aplica significa descartar la alerta; no implica editar la auditoría.</p>'+jump('findings','Entender los hallazgos')+'</article><article><span>🌎 FOCO DE GESTIÓN</span><h4>Comparar con contexto</h4><p>Consulta el volumen y los pendientes por estudio, país o región. Una tasa aislada no indica mejor desempeño si la revisión está incompleta.</p>'+jump('comparison','Comparar territorios')+'</article></div>');
    }
    if(section==='pending') {
      html+=panel('Qué falta por revisar',num(c.pending)+' alertas pendientes en '+num(narrative.pendingAudits)+' auditorías. Los grupos siguientes cuentan auditorías, no alertas.','<p class="story-note">Las cargas reemplazadas y los registros retirados se excluyen. La gestión de descargar, reasignar o retirar pendientes se conserva en el panel de supervisión.</p>');
      const labels={recent:['0–6 días','blue','📅'],week:['7–14 días','orange','⏳'],old:['15 días o más','magenta','🚩'],missing:['Sin fecha original','purple','❔'],future:['Fecha futura','cyan','🗓️']};
      html+=panel('Pendientes por antigüedad','Días calendario desde la fecha original de auditoría, no desde la jornada de carga. Pulsa un grupo para consultar sus IDs.',
        '<div class="indicator-cards indicator-cards--backlog">'+Object.entries(labels).map(([k,[label,tone,symbol]],i)=>'<button type="button" class="stat-card indicator-card indicator-bucket indicator-tone-'+tone+'" style="--indicator-order:'+i+'" data-indicator-bucket="'+k+'" aria-pressed="false"><span class="indicator-card-main"><span class="stat-icon-wrapper indicator-card-icon" aria-hidden="true">'+symbol+'</span><span class="stat-details"><span class="stat-label">'+label+'</span><strong class="stat-value">'+num(result.backlog[k].length)+'</strong><small>Auditorías pendientes</small></span></span><span class="indicator-bucket-link">Ver detalle <span aria-hidden="true">→</span></span></button>').join('')+'</div><div data-indicator-backlog></div>');
    }
    if(section==='findings') {
      html+=panel('Qué confirmó la revisión','Porcentajes sobre todas las alertas recibidas en este alcance; los pendientes no se interpretan como descartados.',decisionBar(c));
      html+=panel('Motivos de No aplica','Participación sobre las alertas descartadas, no sobre el total recibido. Hasta 15 motivos; el CSV conserva el detalle.',table(['Motivo','Alertas descartadas','% de descartadas'],result.reasons.slice(0,15).map(r=>row([esc(r.name),num(r.count),pct(r.share)]))));
      html+=panel('Top alertas con mayor tasa de rechazo','Hasta 20 variables. No aplica / alertas recibidas; leer siempre junto a volumen, cobertura y pendientes.',table(['Variable','Alertas','No aplica','Rechazo','Cobertura','Pendientes'],result.rejectedTypes.slice(0,20).map(r=>row([esc(r.name),num(r.total),num(r.rejects),pct(r.rejection),pct(r.coverage),num(r.pending)]))));
      html+=panel('Auditores con alertas recurrentes','Últimas ocho semanas calendario dentro del filtro, desde '+result.startWeek+'. Recurrencia no es productividad ni error confirmado.',table(['Auditor','Estudio','Semanas con alertas','Alertas'],result.recurrence.slice(0,20).map(r=>row([esc(r.auditor),esc(r.study),num(r.weeks)+' / 8',num(r.total)]))));
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
    const catalog=(root.PortalIndicatorCatalog || []).filter(r=>r.section===(executive?'Resumen mensual':'Operación'));
    html+=panel('Definiciones y datos que aún faltan','Los indicadores sin una definición o fuente suficiente no se calculan.',catalog.map(r=>'<details><summary>'+esc(r.id+' · '+r.name)+(r.reason?' · Pendiente':'')+'</summary><p>'+esc(r.formula || r.reason)+'</p></details>').join(''));
    html+=panel('Reportes clásicos y exportaciones','Se conservan a continuación el histórico, las tablas y descargas anteriores. Usan los filtros generales de estudio, país / región, módulo y fecha del portal; no el mes ni los filtros adicionales de esta lectura.', '<p class="story-note">Pueden tener una base distinta: incluyen el módulo seleccionado (también Smart en Consolidado). Por eso sus totales no necesariamente coinciden con el resumen de Bloqueantes.</p>');
    }
    target.innerHTML=html;
    target.querySelectorAll('[data-story-section]').forEach(el=>el.addEventListener('click',()=>{app[sectionKey]=el.dataset.storySection;render(app,audits);target.querySelector('[aria-current="page"]')?.focus({preventScroll:true});}));
    target.querySelectorAll('[data-indicator-filter]').forEach(el=>el.addEventListener('change',()=>{state[el.dataset.indicatorFilter]=el.value;render(app,audits);}));
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
  root.PortalIndicators={adapt,canonical,render,csv,download,esc,table,row,panel,story,decisionBar,journey};
  if(typeof module!=='undefined')module.exports=root.PortalIndicators;
})(typeof globalThis!=='undefined'?globalThis:this);
