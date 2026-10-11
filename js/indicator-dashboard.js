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
        country:countryFor ? countryFor(a) : field(a,['pais','country']),
        auditor:field(a,['usuario','auditor','nombre_usuario']) || fallback(['auditor']),
        pdv:field(a,['idPDV','pdv']) || fallback(['pdv_id']),
        region:field(a,['region']) || fallback(['region']), channel:field(a,['canal','channel']) || fallback(['channel']),
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
  function render(app, audits) {
    if (!M || !root.document) return;
    const executive = app.reportsSubtab === 'executive' || app.visualizationTab === 'committee';
    const target = document.getElementById(executive ? 'indicators-executive' : 'indicators-operational');
    if (!target) return;
    if (app.currentView !== 'visualizations' && app.currentTab !== 'reports') return;
    const module = app.currentView === 'visualizations' ? app.getVisualizationModuleFilter() : app.currentModule;
    if (module === 'smart') {target.innerHTML=''; return;}
    const state = app.indicatorFilters ||= {region:'all',channel:'all',subchannel:'all',month:''};
    const inputs = adapt(audits, [...(app.adminExternalAnalysis?.alertRecords || []),...(app.benchmarkCountryRows || [])],a=> {
      if (!app.isCountryReportPeriod(a)) return 'Sin país identificado';
      return app.getBenchmarkCountry(a);
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
    const result=M.compute(inputs,{...state,asOf,from,to:app.visualizationDateTo || asOf,month:state.month});
    const c=executive ? result.monthlyCounts : result.counts;
    let html=panel('Indicadores de Alertas Bloqueantes', 'Datos reales · Una auditoría única por estudio y módulo. Comparte los filtros de estudio, país y fecha del portal. No incluye Smart.',
      '<div class="indicator-controls">'+controls+'<button class="btn btn-success btn-sm" data-indicator-download><span aria-hidden="true">📥</span> Descargar detalle (CSV)</button></div>'+cards([
        ['Alertas recibidas',num(c.total),'','blue','📥'],['Cobertura de revisión',pct(c.coverage),num(c.applies+c.rejects)+' decididas','purple','🔎',c.coverage],
        ['Aplicación',pct(c.application),num(c.applies)+' Aplica','green','✅',c.application],['Rechazo',pct(c.rejection),num(c.rejects)+' No aplica','magenta','✋',c.rejection],['Alertas pendientes',num(c.pending),'Por revisar','orange','⏳']
      ])+'<p class="panel-desc">Aplica + No aplica + pendientes = total de alertas. No aplica no implica una edición. País no desglosado para jornadas anteriores a octubre de 2026.</p>');
    if(!executive) {
      const labels={recent:['0–6 días','blue','📅'],week:['7–14 días','orange','⏳'],old:['15 días o más','magenta','🚩'],missing:['Sin fecha original','purple','❔'],future:['Fecha futura','cyan','🗓️']};
      html+=panel('Pendientes por antigüedad','Días calendario desde la fecha original de auditoría, no desde la jornada de carga. Pulsa un grupo para consultar sus IDs.',
        '<div class="indicator-cards indicator-cards--backlog">'+Object.entries(labels).map(([k,[label,tone,symbol]],i)=>'<button type="button" class="stat-card indicator-card indicator-bucket indicator-tone-'+tone+'" style="--indicator-order:'+i+'" data-indicator-bucket="'+k+'" aria-pressed="false"><span class="indicator-card-main"><span class="stat-icon-wrapper indicator-card-icon" aria-hidden="true">'+symbol+'</span><span class="stat-details"><span class="stat-label">'+label+'</span><strong class="stat-value">'+num(result.backlog[k].length)+'</strong><small>Auditorías pendientes</small></span></span><span class="indicator-bucket-link">Ver detalle <span aria-hidden="true">→</span></span></button>').join('')+'</div><div data-indicator-backlog></div>');
      html+=panel('Motivos de No aplica','Conteo sobre el total de rechazos. Sin tipificación se presenta explícitamente.',table(['Motivo','Rechazos','Participación'],result.reasons.slice(0,15).map(r=>row([esc(r.name),num(r.count),pct(r.share)]))));
      html+=panel('Auditores con alertas recurrentes','Últimas ocho semanas calendario dentro del filtro, desde '+result.startWeek+'. Recurrencia no es productividad ni error confirmado.',table(['Auditor','Estudio','Semanas con alertas','Alertas'],result.recurrence.slice(0,20).map(r=>row([esc(r.auditor),esc(r.study),num(r.weeks)+' / 8',num(r.total)]))));
      html+=panel('Tiempo entre cada paso','Bases separadas: una muestra por auditoría para auditoría → carga; una por alerta decidida para carga → decisión. Horas solo con timestamps completos.',cards([['Auditoría → carga',time(result.timing.intake),'','blue','📤'],['Carga → decisión',time(result.timing.validation),'','purple','⏱️']],'timing'));
    } else {
      html+=panel('Tendencia mensual y falsos positivos','No aplica / total de alertas, junto a cobertura. La variación de volumen solo compara dos meses completos consecutivos.',table(['Mes','Estudio','País','Alertas','Cobertura','Rechazo','Variación de alertas vs. mes anterior'],result.monthly.map(r=>row([r.month,esc(r.study),esc(r.country),num(r.total),pct(r.coverage),pct(r.rejection),r.change==null?'No comparable':pct(r.change)]))));
      html+=panel('Benchmark del mes '+esc(state.month),'Desglose por estudio y país; incluye pendientes para interpretar las tasas.',table(['Estudio','País','Alertas','Aplica','No aplica','Pendientes','Cobertura','Rechazo'],result.benchmark.map(r=>row([esc(r.study),esc(r.country),num(r.total),num(r.applies),num(r.rejects),num(r.pending),pct(r.coverage),pct(r.rejection)]))));
      html+=panel('Top alertas con mayor tasa de rechazo','Volumen y cobertura acompañan cada tasa.',table(['Variable','Alertas','No aplica','Rechazo','Cobertura','Pendientes'],result.rejectedTypes.slice(0,20).map(r=>row([esc(r.name),num(r.total),num(r.rejects),pct(r.rejection),pct(r.coverage),num(r.pending)]))));
      html+=panel('Evolución de tiempos por mes de carga','Fechas sin hora se miden en días calendario; no se estima una hora inexistente.',table(['Mes de carga','Auditoría → carga','Carga → decisión'],result.timing.monthly.map(r=>row([r.month,time(r.intake),time(r.validation)]))));
    }
    const workload=executive ? result.performance : result.workload;
    html+=panel(executive?'Desempeño por región, canal y subcanal':'Distribución de carga operativa','La base diaria tiene prioridad; el Export general enriquece por ID. Faltantes se muestran sin inferirlos. Se muestran hasta 40 grupos; el CSV contiene el detalle completo.',table(['Estudio','País','Región','Canal','Subcanal','Alertas','Pendientes','Cobertura','Rechazo'],workload.slice(0,40).map(r=>row([esc(r.study),esc(r.country),esc(r.region),esc(r.channel),esc(r.subchannel),num(r.total),num(r.pending),pct(r.coverage),pct(r.rejection)]))));
    const catalog=(root.PortalIndicatorCatalog || []).filter(r=>r.section===(executive?'Resumen mensual':'Operación'));
    html+=panel('Definiciones y datos que aún faltan','Los indicadores sin una definición o fuente suficiente no se calculan.',catalog.map(r=>'<details><summary>'+esc(r.id+' · '+r.name)+(r.reason?' · Pendiente':'')+'</summary><p>'+esc(r.formula || r.reason)+'</p></details>').join(''));
    target.innerHTML=html;
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
  root.PortalIndicators={adapt,canonical,render,csv,download,esc,table,row,panel};
  if(typeof module!=='undefined')module.exports=root.PortalIndicators;
})(typeof globalThis!=='undefined'?globalThis:this);
