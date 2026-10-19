(function(root) {
  'use strict';
  const M = root.PortalIndicatorMetrics;
  const studyLabel = value => root.PortalStudyLabels?.getStudyDisplayName(value) || value;
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
    const identity = a => JSON.stringify([a._studyId || a.estudio,a._countryId || '',
      String(a.id).trim().replace(/^0+(?=\d)/,'').replace(/^([0-9]+)[.,]0+$/,'$1')]);
    // Check the full history before discarding superseded loads or filtering
    // dates. A completed Blocking audit must not become pending on reimport.
    const completedBlocking = new Map();
    for (const a of audits || []) {
      if ((a._module || 'blocking') !== 'blocking' || a.validationStatus !== 'completada') continue;
      const key=identity(a), previous=completedBlocking.get(key);
      if (!previous || Number(a._batchId || 0)>Number(previous._batchId || 0)) completedBlocking.set(key,a);
    }
    const latestBatches = new Map();
    for (const a of audits || []) {
      const day = a._physicalBatchOperationDate || a._batchOperationDate || a.fecha || '';
      const key = JSON.stringify([a._module,a._studyId || a.estudio,a._countryId,day]);
      latestBatches.set(key, Math.max(latestBatches.get(key) || 0, Number(a._batchId || 0)));
    }
    const map = new Map();
    for (const a of audits || []) {
      if (a._pendingResolution === 'removed' || a._pendingResolution === 'replaced') continue;
      const completed=(a._module || 'blocking') === 'blocking' ? completedBlocking.get(identity(a)) : null;
      if (completed && a.validationStatus !== 'completada') continue;
      const batchKey = JSON.stringify([a._module,a._studyId || a.estudio,a._countryId,a._physicalBatchOperationDate || a._batchOperationDate || a.fecha || '']);
      if (Number(a._batchId || 0) < latestBatches.get(batchKey) && a !== completed) continue;
      const key = JSON.stringify([a._module || 'blocking',identity(a)]);
      const prev = map.get(key);
      if (!prev || Number(a._batchId || 0) > Number(prev._batchId || 0) ||
        (Number(a._batchId || 0) === Number(prev._batchId || 0) && a.validationStatus === 'completada' && prev.validationStatus !== 'completada')) map.set(key,a);
    }
    return [...map.values()];
  }
  function adapt(audits, context = [], countryFor = null, sourceModule = 'blocking') {
    const readField=indexedFieldReader();
    const byId = new Map();
    for (const c of context) {
      const id = String(c.audit_external_id || '');
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(c);
    }
    return M.normalizeAudits(canonical(audits).filter(a=> (sourceModule==='all' || (a._module || 'blocking') === sourceModule) && /^\d+$/.test(String(a.id))).map(a=> {
      const candidates = (byId.get(String(a.id)) || []).filter(c=>!c.study || M.normalizeStudy(c.study)===M.normalizeStudy(a.estudio));
      const dimensions=reportDimensions(a,candidates,readField);
      const fallback = names => {
        const values = [...new Set(candidates.map(c=>names.includes('region')?M.normalizeRegion(readField(c,names)):readField(c,names)).filter(Boolean))];
        return values.length === 1 ? values[0] : '';
      };
      const kpis = (a.kpis || []).filter(k=>k.needsReview === true || k.alertaStatus === 'SE ALERTA').map(k=> {
        const r = a.validationResults?.[k.name] || {};
        return {...k, needsReview:true, decision:r.status, reason:r.tipificacion,
          validatedAt:r.supervisorResolvedAt || r.decisionAt || ''};
      });
      const periodDate = a._originalOperationDate || a._batchOperationDate || a.fecha || '';
      return {id:a.id, _module:a._module || 'blocking', study:a.estudio, periodDate,
        startedAt:a.startedAt,completedAt:a.completedAt,validationStatus:a.validationStatus,
        validatorId:a.assignedValidatorId,validatorName:a._validatorName || a.validadorNombre || a.validatorName,validatorCode:a._validatorCode,
        auditDate:readField(a,['fechaAuditoriaOriginal','auditDate','Fecha_del_audito','FECHA_AUDITORIA','FECHA_AUDITO','FECHA_AU']) || fallback(['audit_date']),
        alertUploadedAt:a._originalUploadedAt || a._batchUploadedAt || a._createdAt,
        country:countryFor ? countryFor(a) : readField(a.databricksGeography || {},['country']) || readField(a,['pais','country']),
        // Only the Databricks export / verified historical enrichment can
        // identify the field auditor. Never read it from the uploaded base.
        auditor:databricksAuditor(a,candidates,readField),
        pdv:readField(a,['idPDV','pdv']) || fallback(['pdv_id']),
        region:dimensions.region,channel:dimensions.channel,subchannel:dimensions.subchannel,
        segment:dimensions.segmento,kpis};
    }));
  }
  function reportDimensions(a,candidates=[],readField=field) {
    const result={};
    for(const [key,names] of [['region',['region']],['channel',['channel','canal']],['subchannel',['subchannel','subcanal']],['segmento',['segmento']]]) {
      const clean=value=>{
        const text=String(value ?? '').trim().replace(/\s+/g,' ');
        return key==='region'?M.normalizeRegion(text):/^(sin (canal|subcanal|segmento)( identificad[oa])?|null|undefined|n\/?a|-)$/i.test(text)?'':text;
      };
      const relevant=candidates.filter(c=>!c.study || M.normalizeStudy(c.study)===M.normalizeStudy(a.estudio));
      const values=[...new Map(relevant.map(c=>clean(readField(c,names))).filter(Boolean)
        .map(v=>[v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),v])).values()];
      result[key+'Ambiguous']=values.length>1 || !values.length && a.databricksGeography?.[key+'Ambiguous']===true;
      result[key]=result[key+'Ambiguous']?'':values[0] || clean(readField(a.databricksGeography || {},names)) || clean(readField(a,names));
    }
    return result;
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
  const decisionLabel = value => ({aplica:'Alertas válidas',no_aplica:'Alertas no válidas',pendiente:'Pendiente'}[value] || value);
  function alertExport(audits, context = [], countryFor = null, sourceModule = 'all', {includeRows = true} = {}) {
    const source = canonical(audits).filter(a => (sourceModule === 'all' || (a._module || 'blocking') === sourceModule) && /^\d+$/.test(String(a.id)));
    const adapted = adapt(source, context, countryFor, sourceModule);
    const inputs = M.excludeUndatedPending(adapted);
    const sourceById = new Map(adapted.map((a,i)=>[JSON.stringify([a.module,a.study,a.id]),source[i]]));
    const rows = includeRows ? inputs.flatMap(a => a.kpis.map(k => {
      const raw = sourceById.get(JSON.stringify([a.module,a.study,a.id])), decision = raw.validationResults?.[k.key] || {};
      return [a.module === 'smart' ? 'Smart' : 'Bloqueantes',a.id,a.pdv,a.periodDate,a.auditDate,a.alertUploadedAt,k.validatedAt,
        studyLabel(a.study),a.country,a.region,a.channel,a.subchannel,a.auditor,raw._validatorName || raw.assignedValidatorId || '',
        k.name,decisionLabel(k.decision),k.reason,decision.observaciones || '',raw.validationStatus || '',a.segment,
        a.startedAt,a.completedAt,...Object.values(M.validationSlaExport(a))];
    })) : [];
    return {inputs,rows,headers:['Módulo','ID auditoría','ID PDV','Jornada','Fecha auditoría original','Fecha de carga','Fecha de decisión',
      'Estudio','País','Región','Canal','Subcanal','Auditor','Validador','Sub-KPI','Decisión','Tipificación','Observaciones','Estado auditoría','Segmento',
      'Inicio de validación','Fin de validación',...Object.keys(M.validationSlaExport({}))],
      counts:M.totals(inputs.flatMap(a=>a.kpis)),audits:inputs.filter(a=>a.kpis.length).length};
  }
  function signalPanel(result) {
    const signals = root.PortalIndicatorReport?.signals(result) || [];
    if (!signals.length) return '';
    return panel('🚦 Semáforos de revisión','Criterios orientativos sobre el alcance seleccionado. El estado se acompaña de su valor y criterio.',
      '<div class="metric-signals">'+signals.map(signal=>'<article class="metric-signal metric-signal--'+signal.tone+'"><div><span class="metric-signal-dot" aria-hidden="true"></span><strong>'+esc(signal.name)+'</strong></div><p><b>'+esc(signal.value)+'</b> · '+esc(signal.label)+'</p><small>'+esc(signal.detail)+'</small><small class="metric-signal-rule">'+esc(signal.rule)+'</small></article>').join('')+'</div>');
  }
  function time(t) { return (t.meanDays == null ? 'Sin muestras' : decimal(t.meanDays)+' días')+' · '+num(t.measured)+' muestras'+
    (t.exact ? '<br>'+decimal(t.meanHours)+' horas · '+num(t.exact)+' con hora exacta' : '')+
    '<br><small>Sin fecha: '+num(t.missing)+' · Inválidas: '+num(t.invalid)+' · Futuras: '+num(t.future)+'</small>'; }
  const slaDefinition='SLA de validación = tiempo transcurrido desde que se inicia la revisión hasta que se completa la auditoría; incluye pausas. Una medición por auditoría y módulo, sin multiplicarla por sus KPIs. Solo se promedian completadas con inicio y cierre con hora válidos. No se sustituyen tiempos faltantes por cero ni por duraciones estimadas.';
  function validationSlaPanel(result) {
    const s=result.sla;
    return panel('SLA de validación por auditoría',slaDefinition,cards([
      ['SLA promedio en validar',esc(M.formatSla(s.meanSeconds)),num(s.measured)+' auditorías con tiempo medible','cyan','⏱️'],
      ['Mediana de validación',esc(M.formatSla(s.medianSeconds)),'La mitad de las mediciones no supera este tiempo','blue','📊'],
      ['P90 de validación',esc(M.formatSla(s.p90Seconds)),'El 90% de las mediciones no supera este tiempo','purple','📈']
    ])+'<p class="story-note">'+num(s.completed)+' completadas · '+num(s.measured)+' medibles · '+num(s.missing)+' sin inicio o cierre con hora · '+num(s.invalid)+' con fechas inválidas · '+num(s.future)+' posteriores al corte.</p>')+
      panel('SLA por validador','Ordenado por auditorías completadas. Mediana y P90 se calculan desde las auditorías individuales; el promedio general no promedia promedios de validadores.',
        chartDetails(table(['Validador','Código','Auditorías completadas','Con SLA medible','Sin SLA medible','SLA promedio','Mediana','P90','Tiempo total de validación'],s.validators.map(v=>row([
          esc(v.name),esc(v.code || v.id || 'Sin identificar'),num(v.completed),num(v.measured),num(v.completed-v.measured),
          esc(M.formatSla(v.meanSeconds)),esc(M.formatSla(v.medianSeconds)),esc(M.formatSla(v.p90Seconds)),esc(M.formatSla(v.totalSeconds))
        ]))),{collapsible:false}));
  }
  const outcomeSeries = [
    {key:'total',label:'Alertas generadas',tone:'blue'},
    {key:'applies',label:'Alertas válidas',tone:'green'},
    {key:'rejects',label:'Alertas no válidas',tone:'magenta'}
  ];
  function chartLegend(series) {
    return '<div class="metric-chart-legend">'+series.map(s=>'<span class="indicator-tone-'+s.tone+'"><i aria-hidden="true"></i>'+esc(s.label)+'</span>').join('')+'</div>';
  }
  function chartDetails(content, {collapsible=true}={}) {
    return '<div class="metric-chart-data"><div class="metric-table-actions"><button type="button" class="btn btn-outline btn-sm" data-chart-table-export>📥 Exportar tabla (CSV)</button></div>'+
      (collapsible?'<details class="metric-chart-details"><summary>Ver datos en tabla</summary>'+content+'</details>':content)+'</div>';
  }
  function chartTableData(wrapper) {
    const table=wrapper.querySelector('table');
    if(!table)return {headers:[],rows:[]};
    const cellText=cell=>{
      if(cell.dataset?.exportValue!==undefined)return cell.dataset.exportValue;
      const text=node=>node.nodeName==='BR'?' ':node.nodeType===3?node.textContent:[...node.childNodes].map(text).join('');
      return text(cell).replace(/\s+/g,' ').trim();
    };
    const headers=[...table.querySelectorAll('thead th')].map(cellText);
    // Includes collapsed study territories; an empty-state colspan is not data.
    const rows=[...table.querySelectorAll('tbody tr')].filter(tr=>tr.cells.length===headers.length && !tr.querySelector('[colspan]')).map(tr=>[...tr.cells].map(cellText));
    return {headers,rows};
  }
  function bindChartTableExports(target,{suffix=''}={}) {
    target.querySelectorAll('[data-chart-table-export]').forEach(button=>{
      const wrapper=button.closest('.metric-chart-data');
      const title=wrapper.closest('section')?.querySelector('h3')?.textContent?.trim() || 'Datos de la gráfica';
      button.disabled=!chartTableData(wrapper).rows.length;
      button.setAttribute('aria-label','Exportar tabla (CSV): '+title);
      button.title='Descarga todas las filas de esta tabla según los filtros activos.';
      button.addEventListener('click',()=>{
        const {headers,rows}=chartTableData(wrapper);
        const slug=title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'');
        download(headers,rows,'Tabla-'+slug+(suffix?'-'+suffix:'')+'.csv');
      });
    });
  }
  // Values and series labels remain readable without color, hover or scripts.
  // All rows in a chart share the same zero-based scale; null is never zero.
  function groupedChart(items,series,{label=r=>r.name,meta=()=>'',format=num,unit='alertas',kind='grouped'}={}) {
    if(!items.length)return '<p class="indicator-empty">Sin registros para graficar en este alcance.</p>';
    const values=items.flatMap(r=>series.map(s=>r[s.key])).filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0);
    const max=Math.max(1,...values);
    return '<div class="metric-chart metric-chart--'+kind+'" data-metric-chart="'+kind+'">'+chartLegend(series)+
      '<p class="metric-chart-scale">Escala común: 0 a '+format(max)+' '+esc(unit)+'</p><div class="metric-chart-rows">'+items.map(r=>
      '<article class="metric-chart-row"><div class="metric-chart-label"><strong>'+esc(label(r))+'</strong>'+(meta(r)?'<small>'+esc(meta(r))+'</small>':'')+'</div><div class="metric-chart-series">'+series.map(s=>{
        const v=r[s.key],known=typeof v==='number'&&Number.isFinite(v)&&v>=0;
        const value=known?format(v):esc(typeof v==='string'?v:'Sin muestras');
        return '<div class="metric-chart-series-row indicator-tone-'+s.tone+'"><span class="metric-chart-series-name">'+esc(s.label)+'</span><div class="metric-chart-track" aria-hidden="true"><span class="metric-chart-fill" style="width:'+(known?v/max*100:0)+'%"></span></div><strong class="metric-chart-value">'+value+(s.shareKey?'<small class="metric-receipt-share">'+pct(r[s.shareKey])+'</small>':'')+'</strong></div>';
      }).join('')+'</div></article>').join('')+'</div></div>';
  }
  function outcomeChart(items,{label=r=>r.name,meta=()=>''}={}) {
    if(!items.length)return '<p class="indicator-empty">Sin alertas generadas para graficar en este alcance.</p>';
    const series=[{key:'applies',label:'Alertas válidas',tone:'green'},{key:'rejects',label:'Alertas no válidas',tone:'magenta'},{key:'pending',label:'Pendientes',tone:'orange'}];
    const max=Math.max(1,...items.map(r=>r.total));
    return '<div class="metric-chart" data-metric-chart="outcomes">'+chartLegend(series)+'<p class="metric-chart-scale">Volumen de alertas generadas · escala común de 0 a '+num(max)+'</p><div class="metric-chart-rows">'+items.map(r=>
      '<article class="metric-chart-row"><div class="metric-chart-label"><strong>'+esc(label(r))+'</strong>'+(meta(r)?'<small>'+esc(meta(r))+'</small>':'')+'</div><div class="metric-outcome-body"><div class="metric-outcome-line"><div class="metric-chart-track metric-outcome-track" aria-hidden="true">'+series.map(s=>'<span class="metric-chart-fill indicator-tone-'+s.tone+'" style="width:'+r[s.key]/max*100+'%"></span>').join('')+'</div><strong>'+num(r.total)+'</strong></div><div class="metric-outcome-values">'+series.map(s=>'<span class="indicator-tone-'+s.tone+'">'+esc(s.label)+' <b>'+num(r[s.key])+'</b></span>').join('')+'</div></div></article>').join('')+'</div></div>';
  }
  function decisionDonut(c) {
    if(!c.total)return '<p class="indicator-empty">Sin alertas generadas para calcular la distribución.</p>';
    const applies=c.applies/c.total*100,decided=(c.applies+c.rejects)/c.total*100;
    const series=[{key:'applies',label:'Alertas válidas',tone:'green'},{key:'rejects',label:'Alertas no válidas',tone:'magenta'},{key:'pending',label:'Pendientes',tone:'orange'}];
    series.sort((a,b)=>c[b.key]-c[a.key]);
    return '<div class="metric-donut-layout" data-metric-chart="donut"><div class="metric-donut" style="--donut-applies:'+applies+'%;--donut-decided:'+decided+'%" aria-hidden="true"><div><strong>'+num(c.total)+'</strong><span>Alertas generadas</span></div></div><div class="metric-donut-key">'+series.map(s=>'<div class="indicator-tone-'+s.tone+'"><i aria-hidden="true"></i><span>'+s.label+'</span><strong>'+num(c[s.key])+'</strong><small>'+pct(c[s.key]/c.total)+'</small></div>').join('')+'</div></div>'+
      chartDetails(table(['Resultado','Alertas','% de alertas generadas'],series.map(s=>row([s.label,num(c[s.key]),pct(c[s.key]/c.total)]))));
  }
  function monthlyTrend(range,month='',limit=null) {
    const scopes=new Map();
    for(const a of range.alerts.filter(a=>a.month && (!month || a.month<=month))) {
      if(!scopes.has(a.month))scopes.set(a.month,[]);
      scopes.get(a.month).push(a);
    }
    let trend=[...scopes].sort(([a],[b])=>a.localeCompare(b)).map(([m,alerts])=>{
      const counts=M.totals(alerts),decided=counts.applies+counts.rejects;
      return {month:m,...counts,decided,confirmation:decided?counts.applies/decided:null,discard:decided?counts.rejects/decided:null,
        partial:range.monthly.some(r=>r.month===m&&r.partial)};
    });
    for(let i=0;i<trend.length;i++) {
      const r=trend[i],p=trend[i-1],d=new Date(r.month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);
      r.change=p && !p.partial && !r.partial && p.month===d.toISOString().slice(0,7) && p.total ? (r.total-p.total)/p.total : null;
    }
    return limit?trend.slice(-limit):trend;
  }
  function monthlyChart(trend) {
    return groupedChart(trend,outcomeSeries,{label:r=>r.month+(r.partial?' · Parcial':''),meta:r=>num(r.pending)+' pendientes',kind:'monthly'})+
      '<p class="story-note">Alertas generadas = Alertas válidas + Alertas no válidas + pendientes. Una auditoría puede generar varias alertas. Las decisiones corresponden al estado actual de cada cohorte mensual. Los meses sin registros no se dibujan como cero.</p>';
  }
  function timingChart(items) {
    return groupedChart(items.map(r=>({month:r.month,intake:r.intake.meanDays,validation:r.validation.meanDays,
      samples:'Muestras: '+num(r.intake.measured)+' auditorías / '+num(r.validation.measured)+' alertas decididas'})),
      [{key:'intake',label:'Tiempo auditoría → generación de alerta',tone:'blue'},{key:'validation',label:'Generación de alerta → decisión aplicada',tone:'purple'}],
      {label:r=>r.month,meta:r=>r.samples,format:decimal,unit:'días calendario',kind:'timing'})+
      '<p class="story-note">Las barras miden días calendario: 0 indica que ambos pasos ocurrieron el mismo día. La tabla conserva las horas exactas cuando están disponibles y el detalle de fechas faltantes o inválidas.</p>';
  }
  function universe(app,state,{auditors=false,channelSegments=false}={}) {
    const studyName=s=>M.normalizeAudits([{id:'1',study:s,kpis:[]}])[0]?.study;
    const studies=(app.selectedStudies||['ALL']).includes('ALL')?[]:(app.selectedStudies||[]).map(studyName);
    const filters={studies,month:state.month||'',from:app.visualizationDateFrom||'',to:app.visualizationDateTo||'',country:app.selectedMetricsCountry||'all',geography:app.selectedReportCountry||'all',region:state.region,channel:state.channel,subchannel:state.subchannel};
    if(auditors)filters.include_auditors=true;
    if(channelSegments)filters.include_channel_segments=true;
    const canQuery=!app.backend?.configured || ['admin','supervisor','visualizer','commercial'].includes(app.currentRole);
    const key=JSON.stringify([app.currentProfile?.id || app.currentProfile?.username || null,app.currentRole,filters]);
    app.databricksTotalsCache ||= new Map();
    // Reports also render while init restores auth. Do not cache an anonymous
    // permission error and reuse it after the staff session becomes available.
    let entry=canQuery?app.databricksTotalsCache.get(key):{loading:true,data:null,error:''};
    if(canQuery && (!entry || !entry.refreshing && Date.now()-entry.loadedAt>5*60*1000 && Date.now()-(entry.attemptedAt||0)>=15000)) {
      const previous=entry;
      entry={loading:!previous?.data,refreshing:true,data:previous?.data||null,error:'',warning:'',loadedAt:previous?.loadedAt||0,
        attemptedAt:Date.now(),retryCount:previous?.retryCount||0};app.databricksTotalsCache.set(key,entry);
      if(app.databricksTotalsCache.size>12)app.databricksTotalsCache.delete(app.databricksTotalsCache.keys().next().value);
      if(app.backend?.loadDatabricksAuditTotals)app.backend.loadDatabricksAuditTotals(filters).then(data=>{
        entry.data=data;entry.loadedAt=Date.now();entry.retryCount=0;
      }).catch(error=>{
        if(entry.data && error.metricsRetryable)entry.warning='No se pudo actualizar. Se muestra el último dato consultado para estos filtros; consulta su fecha de corte.';
        else {entry.data=null;entry.error=error.message || 'No fue posible consultar los totales.';}
        if(error.metricsRetryable && entry.retryCount<1) {
          entry.retryCount++;
          entry.retryTimer=setTimeout(()=>{
            if(app.databricksTotalsCache.get(key)===entry && app.currentView==='visualizations')app.renderReportsView();
          },15050);
          entry.retryTimer?.unref?.();
        }
      }).finally(()=>{entry.loading=false;entry.refreshing=false;entry.attemptedAt=Date.now();if(app.currentView==='visualizations')app.renderReportsView();});
      else {entry.loading=false;entry.refreshing=false;entry.error='Fuente no disponible';}
    }
    const rows=entry.data?.studies||[],names=studies.length?studies:['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley'];
    const supported=new Set(['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley']);
    const snapshots=(entry.data?.snapshots||[]).filter(s=>/^Databricks/i.test(s.source)),verified=snapshots.length>0;
    const partial=names.some(n=>!supported.has(n)&&!rows.some(r=>r.study_name===n));
    const total=entry.data&&snapshots.some(s=>/^Databricks/i.test(s.source))&&names.some(n=>supported.has(n))?rows.reduce((n,r)=>n+Number(r.databricks_total||0),0):null;
    return {entry,rows,names,verified,partial,total,snapshots};
  }
  function receiptShare(received, lifted) {
    return typeof received==='number' && Number.isFinite(received) && received>=0
      && typeof lifted==='number' && Number.isFinite(lifted) && lifted>0 ? received/lifted : null;
  }
  const totalsWarning=u=>u.entry.warning?'<p role="status">'+esc(u.entry.warning)+'</p>':u.entry.refreshing && u.entry.data?'<p role="status">Actualizando totales…</p>':'';
  const comparisonHeaders=['Auditorías','Auditorías con alerta','Alertas generadas','Alertas válidas','% de auditorías alertadas','Promedio de alertas por auditoría alertada','% de alertas válidas entre revisadas'];
  const comparisonDefinitions='Auditorías = total levantado, incluidas las que no generaron alertas. Los IDs alertados se cuentan una vez por estudio, incluso si están en ambos módulos. Alertas generadas = total de alertas recibidas; Alertas válidas = alertas confirmadas en la revisión. % de auditorías alertadas = auditorías con alerta / total levantado × 100. Promedio = alertas generadas / auditorías con alerta. % de alertas válidas entre revisadas = válidas / (válidas + no válidas) × 100; excluye pendientes. Sin denominador se muestra «Sin base». El total levantado usa el mes de Ola y la fecha original; las alertas usan la jornada de carga.';
  function comparisonStatistics(total,applies,rejects,alertedAudits) {
    return {meanAlerts:receiptShare(total,alertedAudits),validShare:receiptShare(applies,applies+rejects)};
  }
  function comparisonCells(r,baseStatus) {
    const average=r.meanAlerts==null?'Sin base':r.meanAlerts.toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2});
    return [r.audits===null?baseStatus:num(r.audits),num(r.alertedAudits),num(r.total),num(r.applies),pct(r.alertedShare),average,pct(r.validShare)];
  }
  function auditorComparisonData(result,u) {
    const key=value=>String(value||'').trim().replace(/\s+/g,' ').toLowerCase();
    const identified=value=>value && !/^(sin (auditor|identificar)|n\/?a|null)$|^auditor\s*\([^)]*\)$|^\d+$/i.test(value);
    const ready=!u.entry.loading && !u.entry.error && u.verified && u.entry.data?.auditor_totals_ready===true;
    const groups=new Map();
    const groupFor=auditor=>{
      if(!groups.has(auditor))groups.set(auditor,{auditor,audits:null,ids:new Set(),total:0,applies:0,rejects:0});
      return groups.get(auditor);
    };
    if(ready)for(const base of u.entry.data.auditors || []) {
      const auditor=key(base.auditor),count=Number(base.databricks_total);
      if(!identified(auditor) || !Number.isFinite(count) || count<0)continue;
      groupFor(auditor).audits=count;
    }
    let unidentified=0;
    for(const alert of result.alerts) {
      const auditor=key(alert.auditor);
      if(!identified(auditor)){unidentified++;continue;}
      const group=groupFor(auditor);
      group.ids.add(JSON.stringify([alert.study,String(alert.id).replace(/^0+/,'') || '0']));
      group.total++;
      if(alert.decision==='aplica')group.applies++;
      if(alert.decision==='no_aplica')group.rejects++;
    }
    const rows=[...groups.values()].map(({ids,...group})=>({...group,alertedAudits:ids.size,alertedShare:receiptShare(ids.size,group.audits),...comparisonStatistics(group.total,group.applies,group.rejects,ids.size)}))
      .sort((a,b)=>b.total-a.total || b.applies-a.applies || a.auditor.localeCompare(b.auditor,'es'));
    return {rows,unidentified,ready};
  }
  function auditorComparison(result,u) {
    const data=auditorComparisonData(result,u);
    const baseStatus=u.entry.loading?'Consultando…':u.entry.error?'Error al consultar':'Sin base';
    return panel('Comparativo por auditor','De mayor a menor por alertas generadas; en empate, por alertas válidas. Incluye todo el período y los filtros seleccionados.',
      totalsWarning(u)+chartDetails(table(['Auditor',...comparisonHeaders],data.rows.map(r=>row([esc(r.auditor),...comparisonCells(r,baseStatus)]))),{collapsible:false})+'<p class="story-note">Auditor de campo del Export de Databricks. '+comparisonDefinitions+' '+num(data.unidentified)+' alertas sin auditor identificado se excluyen de la comparación.</p>'+
      (u.entry.error?'<p role="alert">No fue posible consultar el total de auditorías por auditor: '+esc(u.entry.error)+'</p>':''));
  }
  function territoryComparisonData(result,u) {
    const groups=new Map();
    const key=(study,geography)=>JSON.stringify([study,geography]);
    for(const study of summaryBenchmarkData(result,u))for(const territory of study.territories) {
      groups.set(key(study.study,territory.geography),{study:study.study,geography:territory.geography,audits:territory.lifted,alertedAudits:territory.audits,
        total:territory.total,applies:territory.applies,rejects:territory.rejects,alertedShare:territory.alertedShare});
    }
    const ready=!u.entry.loading && !u.entry.error && u.verified && u.entry.data?.territory_totals_ready===true;
    if(ready)for(const base of u.entry.data.territories || []) {
      const id=key(base.study_name,base.geography),audits=Number(base.databricks_total);
      if(groups.has(id) || base.databricks_total==null || !Number.isFinite(audits) || audits<0)continue;
      groups.set(id,{study:base.study_name,geography:base.geography,audits,alertedAudits:0,total:0,applies:0,rejects:0,alertedShare:receiptShare(0,audits)});
    }
    return [...groups.values()].map(r=>({...r,...comparisonStatistics(r.total,r.applies,r.rejects,r.alertedAudits)}))
      .sort((a,b)=>b.total-a.total || b.applies-a.applies || a.study.localeCompare(b.study,'es') || a.geography.localeCompare(b.geography,'es'));
  }
  function territoryComparison(result,u,scope) {
    const rows=territoryComparisonData(result,u),baseStatus=u.entry.loading?'Consultando…':u.entry.error?'Error al consultar':'Sin base';
    return panel('Comparativo por estudio y territorio',esc(scope)+'. País para KO; región para KO Tradicional CHILE y Lindley. De mayor a menor por alertas generadas; en empate, por alertas válidas.',
      totalsWarning(u)+chartDetails(table(['Estudio','País / región',...comparisonHeaders],rows.map(r=>row([esc(studyLabel(r.study)),esc(r.geography),...comparisonCells(r,baseStatus)]))),{collapsible:false})+
      '<p class="story-note">'+comparisonDefinitions+'</p>'+
      (u.entry.error?'<p role="alert">No fue posible consultar el total de auditorías por territorio: '+esc(u.entry.error)+'</p>':''));
  }
  function channelSegmentComparisonData(result,u) {
    const clean=(value,kind)=>{
      const normalized=String(value??'').trim().replace(/\s+/g,' ').normalize('NFD').replace(/\u0301/g,'').normalize('NFC').toLocaleUpperCase('es');
      return !normalized || normalized===('SIN '+kind.toUpperCase()) || normalized===('SIN '+kind.toUpperCase()+' IDENTIFICADO') ? 'Sin '+kind+' identificado' : normalized;
    };
    const groups=new Map();
    const groupFor=(study,channel,segment)=>{
      channel=clean(channel,'canal');segment=clean(segment,'segmento');
      const key=JSON.stringify([study,channel,segment]);
      if(!groups.has(key))groups.set(key,{study,channel,segment,audits:null,ids:new Set(),total:0,applies:0,rejects:0});
      return groups.get(key);
    };
    const ready=!u.entry.loading && !u.entry.error && u.verified && u.entry.data?.channel_segment_totals_ready===true;
    if(ready)for(const base of u.entry.data.channel_segments || []) {
      const count=Number(base.databricks_total);
      if(base.databricks_total==null || !Number.isFinite(count) || count<0)continue;
      groupFor(base.study_name,base.channel,base.segmento).audits=count;
    }
    for(const alert of result.alerts) {
      const group=groupFor(alert.study,alert.channel,alert.segment);
      group.ids.add(String(alert.id).replace(/^0+/,'')||'0');group.total++;
      if(alert.decision==='aplica')group.applies++;
      if(alert.decision==='no_aplica')group.rejects++;
    }
    return [...groups.values()].map(({ids,...r})=>({...r,alertedAudits:ids.size,alertedShare:receiptShare(ids.size,r.audits),...comparisonStatistics(r.total,r.applies,r.rejects,ids.size)}))
      .sort((a,b)=>b.total-a.total || b.applies-a.applies || a.study.localeCompare(b.study,'es') || a.channel.localeCompare(b.channel,'es') || a.segment.localeCompare(b.segment,'es'));
  }
  function channelSegmentComparison(result,u,scope) {
    const rows=channelSegmentComparisonData(result,u),baseStatus=u.entry.loading?'Consultando…':u.entry.error?'Error al consultar':'Sin base';
    return panel('Comparativo por canal y segmento',esc(scope)+'. Agrupado por estudio, canal y segmento; de mayor a menor por alertas generadas.',
      totalsWarning(u)+chartDetails(table(['Estudio','Canal','Segmento',...comparisonHeaders],rows.map(r=>row([esc(studyLabel(r.study)),esc(r.channel),esc(r.segment),...comparisonCells(r,baseStatus)]))),{collapsible:false})+
      '<p class="story-note">Segmento corresponde a la columna segmento de Databricks. Los registros sin este dato se agrupan como «Sin segmento identificado». '+comparisonDefinitions+'</p>'+
      (u.entry.error?'<p role="alert">No fue posible consultar el total de auditorías por canal y segmento: '+esc(u.entry.error)+'</p>':''));
  }
  function summaryBenchmarkData(result,u) {
    const studies=new Map();
    const create=()=>({ids:new Set(),total:0,applies:0,rejects:0});
    for(const name of u.names)studies.set(name,{...create(),study:name,territories:new Map()});
    for(const alert of result.alerts) {
      if(!studies.has(alert.study))studies.set(alert.study,{...create(),study:alert.study,territories:new Map()});
      const study=studies.get(alert.study),geography=alert.geography;
      if(!study.territories.has(geography))study.territories.set(geography,{...create(),geography});
      for(const group of [study,study.territories.get(geography)]) {
        group.ids.add(String(alert.id).replace(/^0+/,''));group.total++;
        if(alert.decision==='aplica')group.applies++;
        if(alert.decision==='no_aplica')group.rejects++;
      }
    }
    const ready=!u.entry.loading && !u.entry.error && u.verified;
    const base=(rows,key,territory=false)=>{
      const match=rows.filter(key);
      if(!ready || territory && !u.entry.data?.territory_totals_ready)return null;
      if(!territory && !match.length)return 0;
      return match.length?match.reduce((sum,r)=>sum+Number(r.databricks_total||0),0):null;
    };
    return [...studies.values()].map(study=>{
      const lifted=base(u.rows,r=>r.study_name===study.study);
      const finish=(group,total)=>({...group,audits:group.ids.size,lifted:total,alertedShare:receiptShare(group.ids.size,total)});
      const territories=[...study.territories.values()].sort((a,b)=>b.total-a.total || a.geography.localeCompare(b.geography,'es')).map(group=>
        finish(group,base(u.entry.data?.territories||[],r=>r.study_name===study.study && r.geography===group.geography,true)));
      return {...finish(study,lifted),territories};
    }).sort((a,b)=>b.total-a.total || a.study.localeCompare(b.study,'es'));
  }
  function summaryBenchmark(result,u,app) {
    const modules=app.currentScope?.module?[app.currentScope.module]:['blocking','smart'];
    const failed=modules.some(module=>app.auditHistoryErrors?.[module]);
    const loading=app.backend?.configured && modules.some(module=>!Array.isArray(app.auditHistoryByModule?.[module]));
    if(failed || loading)return panel('Resumen por estudio, país y región','Auditorías alertadas / total de auditorías levantadas × 100.', '<p class="story-note">'+(failed?'No se pudo consultar el histórico de alertas. Actualiza para reintentar.':'Consultando el histórico de alertas…')+'</p>');
    const groups=summaryBenchmarkData(result,u);
    app.expandedSummaryStudies ||= new Set();
    const metricCells=group=>{
      const decided=group.applies+group.rejects,confirmation=receiptShare(group.applies,decided);
      return '<td><strong>'+num(group.audits)+'</strong></td><td>'+(group.lifted===null?(u.entry.loading?'Consultando…':'Sin base'):num(group.lifted))+'</td><td><strong>'+pct(group.alertedShare)+'</strong></td><td><span class="badge badge-purple">'+num(group.total)+' alertas</span></td><td><strong class="text-success">'+num(group.applies)+'</strong></td><td><strong class="text-magenta">'+num(group.rejects)+'</strong></td><td>'+pct(confirmation)+'</td>';
    };
    const rows=groups.map((group,i)=>{
      const expanded=app.expandedSummaryStudies.has(group.study),isRegion=['Chile','Lindley'].includes(group.study),unit=isRegion?(group.territories.length===1?'región':'regiones'):(group.territories.length===1?'país':'países');
      const ids=group.territories.map((_,j)=>'summary-territory-'+i+'-'+j).join(' ');
      const button='<button type="button" class="benchmark-expand-toggle" data-summary-study="'+esc(group.study)+'" aria-expanded="'+expanded+'" aria-controls="'+ids+'"><span class="benchmark-expand-chevron" aria-hidden="true">▶</span><span class="benchmark-badge-flag">'+esc(studyLabel(group.study))+'</span><small>'+group.territories.length+' '+unit+'</small></button>';
      return '<tr class="benchmark-study-parent"><td data-export-value="'+esc(studyLabel(group.study))+'">'+(group.territories.length?button:esc(studyLabel(group.study)))+'</td>'+metricCells(group)+'</tr>'+group.territories.map((territory,j)=>'<tr id="summary-territory-'+i+'-'+j+'" class="benchmark-country-row" data-summary-parent="'+esc(group.study)+'" '+(expanded?'':'hidden')+'><td data-export-value="'+esc(studyLabel(group.study)+' / '+territory.geography)+'"><span class="benchmark-country-label">↳ '+esc(territory.geography)+'</span></td>'+metricCells(territory)+'</tr>').join('');
    }).join('');
    return panel('Resumen por estudio, país y región','Auditorías alertadas / total de auditorías levantadas × 100. Despliega cada estudio para consultar su detalle.',
      totalsWarning(u)+chartDetails('<div class="table-responsive benchmark-scroll" tabindex="0" role="region" aria-label="Resumen por estudio, país y región"><table class="data-table benchmark-table summary-benchmark"><thead><tr>'+['Estudio / País / Región','Auditorías alertadas','Total de auditorías','% de auditorías alertadas','Total alertas','Alertas válidas','Alertas no válidas','Tasa de confirmación'].map(label=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>',{collapsible:false})+'<p class="story-note">Orden descendente por alertas generadas, tanto entre estudios como dentro de cada estudio. El CSV incluye todos los países y regiones, aunque estén plegados. El total de auditorías proviene del levantamiento de Databricks. En Consolidado, los IDs alertados se cuentan una sola vez por estudio; las alertas y sus decisiones conservan cada módulo. La tasa de confirmación usa solo alertas revisadas. Los filtros de mes y fecha usan los mismos cortes que el consolidado superior.</p>');
  }
  function universePanel(u,result,smart,app) {
    const unavailable=u.entry.error?'Error al consultar':'Sin corte conectado';
    const receipt=(module,count)=> {
      if(app.currentScope?.module && app.currentScope.module!==module)return 'Fuera de alcance';
      if(app.auditHistoryErrors?.[module])return 'Error al consultar';
      if(app.backend?.configured && !Array.isArray(app.auditHistoryByModule?.[module]))return 'Consultando…';
      return count;
    };
    const display=value=>typeof value==='number'?num(value):esc(value);
    const total=u.entry.loading || u.entry.error || u.partial ? null : u.total;
    const value=u.entry.loading?'Consultando…':u.entry.error || u.total===null?unavailable:num(u.total)+(u.partial?' *':'');
    const alertVolumes=new Map();
    const module=app.currentScope?.module || app.getVisualizationModuleFilter?.() || 'all';
    const rankingAlerts=module==='smart'?(smart.alerts||[]):module==='blocking'?(result.alerts||[]):[...(result.alerts||[]),...(smart.alerts||[])];
    for(const a of rankingAlerts)alertVolumes.set(a.study,(alertVolumes.get(a.study)||0)+1);
    const chartRows=u.names.map(name=>{
      const r=u.rows.find(r=>r.study_name===name),known=u.verified&&['Chile','KO Tradicional CAM','KO Moderno CAM','Lindley'].includes(name);
      const lifted=u.entry.loading?'Consultando…':u.entry.error?unavailable:known?Number(r?.databricks_total||0):unavailable;
      const blocking=receipt('blocking',result.auditCountsByStudy?.[name]||0),smartCount=receipt('smart',smart.auditCountsByStudy?.[name]||0);
      return {name:studyLabel(name),total:alertVolumes.get(name)||0,export:lifted,blocking,smart:smartCount,
        blockingShare:receiptShare(blocking,lifted),smartShare:receiptShare(smartCount,lifted)};
    }).sort((a,b)=>b.total-a.total || a.name.localeCompare(b.name,'es'));
    const blocking=receipt('blocking',result.audits),smartCount=receipt('smart',smart.audits);
    return panel('🌐 Auditorías levantadas y recibidas','Total levantado cuenta todas las auditorías. Las recibidas se cuentan de forma independiente en cada módulo.',cards([
      ['Total levantado',value,'Auditorías únicas por estudio','cyan','🌐'],
      ['Auditorías recibidas en Bloqueantes',display(blocking),pct(receiptShare(blocking,total))+' del total levantado','blue','🚨'],
      ['Auditorías recibidas en Smart',display(smartCount),pct(receiptShare(smartCount,total))+' del total levantado','purple','💡']
    ])+groupedChart(chartRows,[{key:'export',label:'Total levantado',tone:'cyan'},{key:'blocking',label:'Auditorías recibidas en Bloqueantes',tone:'blue',shareKey:'blockingShare'},{key:'smart',label:'Auditorías recibidas en Smart',tone:'purple',shareKey:'smartShare'}],{unit:'auditorías',kind:'universe'})+chartDetails(table(['Estudio','Total levantado','Auditorías recibidas en Bloqueantes','Auditorías recibidas en Smart','% Bloqueantes / levantado','% Smart / levantado'],chartRows.map(r=>
      row([esc(r.name),display(r.export),display(r.blocking),display(r.smart),pct(r.blockingShare),pct(r.smartShare)]))))+
      '<p class="story-note">Porcentaje = auditorías recibidas en el módulo / total levantado. Una auditoría puede estar en ambos módulos; los porcentajes no se suman. El total levantado usa el mes de Ola y, al filtrar días, la fecha original de auditoría; las recibidas usan la jornada de carga. '+(u.snapshots.length?'Cortes: '+u.snapshots.map(s=>esc(String(s.month).slice(0,7))+' · '+esc(s.refreshed_at)).join('; '):'La ausencia de un corte o un error de consulta no se interpreta como cero.')+'</p>'+totalsWarning(u)+(u.entry.error?'<p role="alert">No fue posible consultar el total levantado: '+esc(u.entry.error)+'</p>':'')+'<button type="button" class="btn btn-outline btn-sm" data-universe-refresh>↻ Actualizar totales</button>');
  }
  const journey = [
    ['summary','📊','Resumen','¿Cómo va la operación?'],
    ['evolution','📈','Evolución','¿Qué cambia entre meses?'],
    ['pending','⏳','Pendientes','¿Qué falta por revisar?'],
    ['findings','🔎','Hallazgos','¿Qué confirmó la revisión?'],
    ['comparison','🌎','Comparativas','¿Dónde se concentra?'],
    ['timing','⏱️','Tiempos','¿Cuánto tarda cada paso?']
  ];
  const committeeJourney = [
    ['summary','👔','Resumen para dirección','Volumen, revisión y resultado'],
    ['focus','🌎','Focos de atención','Dónde enfocar la gestión'],
    ['evolution','📈','Evolución','Qué cambia entre meses'],
    ['detail','📥','Detalle operativo','Fuentes, pendientes y descargas']
  ];
  function committeeData(result, range, history, month, filters) {
    const inherited=M.compute(history.filter(a=>a.month && a.month<month),{...filters,from:'',to:filters.asOf,month:''});
    const trend=monthlyTrend(range,month,6);
    return {inherited,trend,timing:range.timing.monthly.filter(r=>r.month<=month).slice(-6),focus:[...result.benchmark].filter(r=>r.pending).sort((a,b)=>b.pending-a.pending||b.total-a.total||a.study.localeCompare(b.study)).slice(0,3)};
  }
  function inheritedPanel(data, month, asOf) {
    const r=data.inherited,s=story(r);
    return '<aside class="glass-panel committee-carryover"><div><span class="corporate-badge">⏳ PENDIENTES HEREDADOS · FUERA DEL TOTAL DEL MES</span><h3>'+num(r.counts.pending)+' alertas en '+num(s.pendingAudits)+' auditorías</h3><p>Jornadas anteriores a '+esc(month || 'la selección')+' que siguen pendientes al '+esc(asOf)+'. Respeta estudio, país / región y filtros adicionales; ignora el rango de fechas para no ocultar el rezago.</p><small>Estado actual, no una fotografía del cierre histórico. '+num(r.backlog.old.length)+' auditorías con 15 días o más.</small></div></aside>';
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
        ['Alertas válidas',num(c.applies),pct(s.confirmation)+' de las revisadas','green','✅'],
        ['Alertas no válidas',num(c.rejects),pct(s.decided?c.rejects/s.decided:null)+' de las revisadas','magenta','✋'],
        ['Pendientes del mes',num(c.pending),num(s.pendingAudits)+' auditorías con alguna pendiente','orange','⏳']
      ],'macro')+panel('📊 Qué nos dicen los resultados','Misma cohorte mensual y filtros; decisiones conocidas al día de consulta.',decisionDonut(c)+'<p class="story-note">Recibidas = Alertas válidas + Alertas no válidas + pendientes. Cobertura = revisadas / recibidas. Confirmación y descarte en las tarjetas = resultado / revisadas. Las alertas no válidas no requieren edición.</p>')+
      '<div class="committee-grid">'+panel('🌎 Dónde concentrar la gestión','Prioridad por volumen de pendientes, no un ranking de desempeño.',data.focus.length?'<ol class="committee-top">'+data.focus.map((r,i)=>'<li><span class="committee-rank">'+(i+1)+'</span><div><strong>'+esc(studyLabel(r.study))+' · '+esc(r.geography)+'</strong><small>'+num(r.pending)+' pendientes · '+pct(c.pending?r.pending/c.pending:null)+' de los pendientes del mes · '+pct(r.coverage)+' de cobertura</small></div></li>').join('')+'</ol>'+jump('focus','Ver focos y contexto'):'<p class="indicator-empty">'+(c.total?'Sin pendientes en el mes seleccionado.':'Sin datos para establecer prioridades.')+'</p>')+
      panel('🎯 Mensaje para el comité','Hechos observados, sin metas ni conclusiones comerciales inventadas.','<p class="committee-message">'+(c.total?'Se revisaron <b>'+pct(c.coverage)+'</b> de las alertas recibidas. '+(s.decided?'De las revisadas, <b>'+pct(s.confirmation)+'</b> se confirmaron. ':'Aún no hay decisiones para evaluar la confirmación. ')+(c.pending?'La lectura sigue abierta: faltan <b>'+num(c.pending)+'</b> decisiones.':'Todas tienen una decisión registrada.'):'No hay alertas para evaluar en esta selección.')+'</p><p class="story-note">Más alertas no implica peor ejecución: puede reflejar más auditorías o mayor detección. Esta vista no mide ahorro, ventas ni retorno financiero.</p>'+jump('decisions','Preparar decisiones'))+'</div>';
    }
    if(section==='focus') return panel('🌎 Dónde enfocar la gerencia','Mes seleccionado. País en KO Tradicional / KO Moderno; región en KO Tradicional CHILE / Lindley. Lee la confirmación junto a cobertura y tamaño de muestra.',
      '<div class="committee-studies">'+macro.studies.map(r=>{
        const territories=result.benchmark.filter(b=>b.study===r.study).sort((a,b)=>b.pending-a.pending||b.total-a.total);
        return '<article><h4>'+esc(studyLabel(r.study))+'</h4><strong>'+num(r.total)+' Alertas generadas</strong><small>'+num(r.audits)+' auditorías con alertas · Cobertura '+pct(r.coverage)+'</small>'+outcomeChart(territories,{label:b=>b.geography})+chartDetails(table(['Territorio','Recibidas','Revisadas','Alertas válidas','Alertas no válidas','Pendientes','Cobertura','Confirmación'],territories.map(b=>row([esc(b.geography),num(b.total),num(b.applies+b.rejects),num(b.applies),num(b.rejects),num(b.pending),pct(b.coverage),pct(b.applies+b.rejects?b.applies/(b.applies+b.rejects):null)]))))+'</article>';
      }).join('')+'</div>'+(c.total?'':'<p class="indicator-empty">Sin estudios con alertas en esta selección.</p>'))+
      panel('🔎 Qué está generando las alertas','Top 3 por volumen recibido, no por errores confirmados.',outcomeChart(macro.variables.slice(0,3))+chartDetails(table(['Variable','Recibidas','Alertas válidas','Alertas no válidas','Pendientes','Cobertura'],macro.variables.slice(0,3).map(r=>row([esc(r.name),num(r.total),num(r.applies),num(r.rejects),num(r.pending),pct(r.coverage)])))))+
      panel('✋ Motivos principales de descarte','Top 3; participación sobre alertas no válidas. Los faltantes permanecen visibles.',groupedChart(result.reasons.slice(0,3),[{key:'count',label:'Alertas no válidas',tone:'magenta'}],{meta:r=>pct(r.share)+' de las descartadas',kind:'ranking'})+chartDetails(table(['Motivo','Descartadas','% de descartadas'],result.reasons.slice(0,3).map(r=>row([esc(r.name),num(r.count),pct(r.share)])))));
    if(section==='evolution') {
      return panel('📈 Evolución mensual de alertas generadas','Comparativo de alertas generadas, válidas y no válidas. Hasta seis meses con datos del rango seleccionado.',
        monthlyChart(data.trend)+chartDetails(table(['Mes de jornada','Alertas generadas','Alertas válidas','Alertas no válidas','Pendientes','Cobertura','Cambio de volumen'],data.trend.map(r=>row([esc(r.month)+(r.partial?' · Parcial':''),num(r.total),num(r.applies),num(r.rejects),num(r.pending),pct(r.coverage),r.change==null?'No comparable':pct(r.change)]))))+'<p class="story-note">Solo se calcula cambio entre meses completos consecutivos. Los meses parciales se identifican y no se comparan como cierres completos.</p>')+
        panel('⏱️ Tiempos de la cohorte seleccionada','Promedios sin meta aprobada. Muestras y fechas faltantes se muestran para no confundir ausencia de información con rapidez.',cards([
          ['Tiempo auditoría → generación de alerta',time(result.timing.intake),'Una muestra por auditoría','blue','📤'],
          ['Generación de alerta → decisión aplicada',time(result.timing.validation),'Una muestra por alerta decidida','purple','⏱️']
        ],'timing')+'<p class="story-note">No es un SLA. La cohorte usa jornada; los intervalos usan las fechas reales de auditoría, carga y decisión.</p>')+
        panel('⏱️ Evolución de los tiempos de respuesta','Promedio en días por mes real de carga. Las dos etapas usan muestras independientes.',timingChart(data.timing)+chartDetails(table(['Mes real de carga','Tiempo auditoría → generación de alerta','Generación de alerta → decisión aplicada'],data.timing.map(r=>row([esc(r.month),time(r.intake),time(r.validation)])))));
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
    const parts=[['Alertas válidas',c.applies,'green'],['Alertas no válidas',c.rejects,'magenta'],['Sin decisión',c.pending,'orange']];
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
      ['Confirmación de alertas',pct(s.confirmation),num(c.applies)+' Alertas válidas / '+num(s.decided)+' revisadas','green','✅',s.confirmation],
      ['Alertas descartadas',num(c.rejects),pct(c.rejection)+' de las recibidas · Alertas no válidas','magenta','✋'],
      ['Alertas pendientes',num(c.pending),num(s.pendingAudits)+' auditorías con alguna pendiente','orange','⏳']
    ],'macro');
    html+='<div class="committee-grid">'+panel('Resultado global del mes','Base: todas las alertas recibidas del mes y filtros seleccionados.',decisionBar(c)+'<p class="story-note">Alertas válidas + Alertas no válidas + pendientes = recibidas. La confirmación de la tarjeta superior usa solo las revisadas. Las alertas no válidas no requieren edición.</p>')+
      panel('Prioridad para el comité','Focos derivados del mes seleccionado, sin metas ni semáforos arbitrarios.',
        '<div class="committee-priority"><strong>'+(focus?esc(studyLabel(focus.study))+' concentra '+pct(focus.pending/c.pending)+' de los pendientes':c.total?'Sin alertas pendientes en este alcance':'Sin datos para establecer una prioridad')+'</strong><p>'+(focus?num(focus.pending)+' de '+num(c.pending)+' alertas pendientes del mes.':'')+'</p><p><b>'+num(result.backlog.old.length)+'</b> auditorías pendientes con 15 días o más desde su fecha original.</p>'+link('pending','Revisar pendientes')+'</div>')+'</div>';
    html+=panel('Comparativa macro por estudio','Mismo mes y filtros. Las barras muestran la composición de cada estudio; los totales permiten comparar volumen. Auditorías: IDs que tienen al menos una alerta.',
      '<div class="committee-studies">'+(macro.studies.length?macro.studies.map(r=>'<article><div class="committee-study-title"><h4>'+esc(studyLabel(r.study))+'</h4><span>'+num(r.total)+' alertas · '+num(r.audits)+' auditorías</span></div>'+decisionBar(r)+'<small>Cobertura: <b>'+pct(r.coverage)+'</b> · Participación en las alertas del mes: <b>'+pct(r.total/c.total)+'</b></small></article>').join(''):'<p class="indicator-empty">Sin estudios con alertas en este mes.</p>')+'</div>'+link('comparison','Ver países, regiones y canales'));
    const top=(items,countKey,total)=>items.slice(0,3).map((r,i)=>'<li><span class="committee-rank">'+(i+1)+'</span><div><strong>'+esc(r.name)+'</strong><small>'+num(r[countKey])+' alertas · '+pct(total?r[countKey]/total:null)+'</small></div></li>').join('') || '<li class="indicator-empty">Sin registros para este mes.</li>';
    html+='<div class="committee-grid">'+panel('Qué variables concentran las alertas','Top 3 por volumen recibido. Una alerta no equivale a un error confirmado.','<ol class="committee-top">'+top(macro.variables,'total',c.total)+'</ol>'+link('findings','Explorar hallazgos'))+
      panel('Por qué se descartaron','Top 3 motivos de alertas no válidas; porcentaje sobre las descartadas. Los faltantes se identifican como Sin tipificación.','<ol class="committee-top">'+top(result.reasons,'count',c.rejects)+'</ol>'+link('findings','Ver motivos'))+'</div>';
    html+=panel('Tiempo de respuesta del mes','Cohorte: auditorías cargadas en el mes seleccionado. Promedios, no plazos comprometidos. Se excluyen intervalos inválidos o sin fechas.',cards([
      ['Tiempo auditoría → generación de alerta',time(result.timing.intake),'Una muestra por auditoría','blue','📤'],
      ['Generación de alerta → decisión aplicada',time(result.timing.validation),'Una muestra por alerta decidida','purple','⏱️']
    ],'timing')+link('timing','Ver detalle de tiempos'));
    return html;
  }
  function render(app, audits, historyAudits = null, prepared = null, receiptAudits = audits) {
    if (!M || !root.document) return;
    const target = document.getElementById('indicators-operational');
    const daily = app.currentRole !== 'commercial' && app.reportsSubtab === 'daily';
    if (!target) return;
    if (app.currentView !== 'visualizations' && app.currentTab !== 'reports') return;
    const module = app.currentView === 'visualizations' ? app.getVisualizationModuleFilter() : app.currentModule;
    const legacy=Array.from(target.parentElement.children).filter(el=>el!==target);
    const state = app.indicatorFilters ||= {region:'all',channel:'all',subchannel:'all',month:''};
    if(state.region!=='all')state.region=M.normalizeRegion(state.region)||'Sin región';
    const options=app.getMetricsScopeOptions?.() || {studies:[],countries:[]};
    state.month=app.selectedMetricsMonth && app.selectedMetricsMonth!=='all'?app.selectedMetricsMonth:'';
    const selectedStudies=app.selectedStudies || ['ALL'];
    const studyValue=!selectedStudies.length || selectedStudies.includes('ALL')?'all':selectedStudies.length===1?selectedStudies[0]:'__multiple__';
    const countryValue=app.selectedMetricsCountry || 'all';
    const scopeSelect=(key,label,value,choices,disabled=false)=>'<label>'+label+'<select class="form-control" data-metric-scope-filter="'+key+'" '+(disabled?'disabled':'')+'>'+choices.map(option=>'<option value="'+esc(option.value)+'" '+(option.value===value?'selected':'')+'>'+esc(option.label)+'</option>').join('')+'</select></label>';
    const scopeControls='<section class="glass-panel metric-scope-panel" aria-label="Filtros de métricas"><div class="metric-scope-title"><strong>Filtrar métricas</strong><small>'+(daily?'La selección aplica al detalle diario y sus descargas. El consolidado histórico se muestra completo.':'La selección aplica a las gráficas, tablas y descargas de este apartado.')+'</small></div><div class="metric-scope-controls">'+
      scopeSelect('study','Estudio',studyValue,[{value:'all',label:'Todos los estudios'},...(studyValue==='__multiple__'?[{value:'__multiple__',label:'Selección múltiple ('+selectedStudies.length+')'}]:[]),...options.studies.map(option=>({...option,label:studyLabel(option.value)}))])+
      scopeSelect('country','País',countryValue,[{value:'all',label:'Todos los países'},...options.countries])+
      scopeSelect('module','Módulo',module,[{value:'all',label:'Bloqueantes + Smart'},{value:'blocking',label:'Bloqueantes'},{value:'smart',label:'Smart'}],app.currentView!=='visualizations')+
      scopeSelect('month','Mes',state.month||'all',[{value:'all',label:'Todos los meses'},...(options.months || [...new Set(audits.map(a=>(a._batchOperationDate||a.fecha||'').slice(0,7)).filter(m=>/^\d{4}-\d{2}$/.test(m)))].sort().reverse().map(value=>({value,label:value})))])+
      '<label>Desde<input class="form-control" type="date" data-metric-scope-filter="from" value="'+esc(app.visualizationDateFrom||'')+'"></label>'+
      '<label>Hasta<input class="form-control" type="date" data-metric-scope-filter="to" value="'+esc(app.visualizationDateTo||'')+'"></label>'+
      '</div><div class="metric-scope-actions"><small>Mes y fechas se combinan por la jornada de auditoría. '+(daily?'El consolidado histórico incluye ambos módulos y todos los meses.':'La evolución compara hasta seis meses del rango.')+'</small><div class="metric-download-actions"><button type="button" class="btn btn-outline btn-sm" data-metric-dates-clear>Limpiar fechas</button>'+(!daily?'<button type="button" class="btn btn-primary btn-sm" data-indicator-pdf>📄 Descargar indicadores (PDF)</button><button type="button" class="btn btn-success btn-sm" data-indicator-download>📥 Descargar detalle de alertas (CSV)</button>':'')+'</div></div></section>';
    const bindScopeControls=()=>{
      target.querySelectorAll('[data-metric-scope-filter]').forEach(el=>el.addEventListener('change',async()=>{
        if(el.value==='__multiple__')return;
        try {await app.setMetricsScopeFilter?.(el.dataset.metricScopeFilter,el.value);}
        catch(error) {console.error('No fue posible aplicar el filtro de métricas:',error);}
      }));
      target.querySelector('[data-metric-dates-clear]')?.addEventListener('click',()=>app.setMetricsScopeFilter?.('dates-clear',''));
      target.querySelector('[data-indicator-pdf]')?.addEventListener('click',()=>app.exportIndicatorPDF?.());
    };
    if(daily) {
      legacy.forEach(el=>el.classList.toggle('indicator-legacy-hidden',true));
      document.getElementById('metrics-view-executive')?.classList?.toggle('hidden',true);
      target.innerHTML=scopeControls;
      bindScopeControls();
      return;
    }
    // Navigation shares this snapshot. A fresh application render after a
    // load/live update always prepares a new one, including in-place edits.
    const context=prepared?null:[...(app.adminExternalAnalysis?.alertRecords || []),...(app.benchmarkCountryRows || [])];
    const snapshot=prepared || {inputs:adapt(audits,context,a=>app.getReportCountry(a),module || 'blocking'),receiptInputs:adapt(receiptAudits,context,a=>app.getReportCountry(a)),smartInputs:adapt(receiptAudits,context,a=>app.getReportCountry(a),'smart'),calculations:new Map()};
    const inputs=snapshot.inputs;
    if(historyAudits && !snapshot.historyInputs)snapshot.historyInputs=historyAudits===audits ? inputs : adapt(historyAudits,context,a=>app.getReportCountry(a),module || 'blocking');
    const historyInputs=snapshot.historyInputs || inputs;
    const asOf = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const dimensions = [['region','Región','Sin región'],['channel','Canal','Sin canal'],['subchannel','Subcanal','Sin subcanal']];
    let controls = dimensions.map(([key,label,missing])=> {
      const values=[...new Set(inputs.map(a=>a[key] || missing))].sort();
      if(state[key]!=='all'&&!values.includes(state[key]))state[key]='all';
      return '<label>'+label+'<select class="form-control" data-indicator-filter="'+key+'"><option value="all">Todas</option>'+values.map(v=>'<option value="'+esc(v)+'" '+(v===state[key]?'selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label>';
    }).join('');
    const firstDate=inputs.map(a=>a.periodDate).filter(Boolean).sort()[0] || '';
    const from=app.visualizationDateFrom || (firstDate?firstDate.slice(0,7)+'-01':'');
    const to=app.visualizationDateTo || asOf;
    const calculationKey=JSON.stringify([state.region,state.channel,state.subchannel,state.month,from,to,asOf]);
    let calculated=snapshot.calculations.get(calculationKey);
    if(!calculated) {
      const rangeResult=M.compute(inputs,{...state,asOf,from,to,month:state.month||''});
      const result=state.month ? M.compute(inputs.filter(a=>a.month===state.month),{...state,asOf,from,to}) : rangeResult;
      const smartInputs=snapshot.smartInputs || [];
      const smart=M.compute(state.month?smartInputs.filter(a=>a.month===state.month):smartInputs,{...state,asOf,from:app.visualizationDateFrom || '',to,month:state.month||''});
      const receiptInputs=snapshot.receiptInputs || inputs;
      const blocking=M.compute(state.month?receiptInputs.filter(a=>a.month===state.month):receiptInputs,{...state,asOf,from:app.visualizationDateFrom || '',to,month:state.month||''});
      calculated={rangeResult,result,smart,blocking,committee:committeeData(result,rangeResult,historyInputs,state.month || to.slice(0,7),{...state,asOf})};
      // Bound retained cohorts while allowing fast back-and-forth navigation.
      if(snapshot.calculations.size>=2)snapshot.calculations.delete(snapshot.calculations.keys().next().value);
      snapshot.calculations.set(calculationKey,calculated);
    }
    const {result}=calculated;
    const c=result.counts, narrative=story(result);
    const sectionKey='indicatorOperationalSection';
    const navigation=journey;
    const section=navigation.some(([id])=>id===app[sectionKey])?app[sectionKey]:'summary';
    legacy.forEach(el=>el.classList.toggle('indicator-legacy-hidden',true));
    document.getElementById('metrics-view-executive')?.classList?.toggle('hidden',true);
    const scope=(state.month?'Mes: '+state.month+' · ':'')+'Jornadas: '+(from || 'Sin fecha')+' a '+to;
    const jump=(id,text)=>'<button type="button" class="btn btn-outline btn-sm" data-story-section="'+id+'">'+text+' →</button>';
    let html='<section class="glass-panel story-header"><div><span class="corporate-badge">'+'MÉTRICAS DE VALIDACIÓN'+' · BLOQUEANTES</span><h2>'+ 'Métricas de validación'+'</h2><p>'+'Estado general, evolución mensual y comparativas de las alertas recibidas y sus decisiones.'+'</p></div><div class="story-scope">'+esc(scope)+'<small>Estudios, país / región y fechas según los filtros del portal. No incluye Smart.</small></div></section>'+
      scopeControls+'<nav class="story-nav'+''+'" aria-label="Apartados de indicadores">'+navigation.map(([id,icon,label,question],i)=>'<button type="button" data-story-section="'+id+'" aria-current="'+(id===section?'page':'false')+'"><span aria-hidden="true">'+icon+'</span><strong>'+(i+1)+'. '+label+'</strong><small>'+question+'</small></button>').join('')+'</nav>'+
      '<details class="glass-panel story-filters" '+(state.region!=='all'||state.channel!=='all'||state.subchannel!=='all'?'open':'')+'><summary>🔍 Afinar esta lectura'+''+' · Región: '+esc(state.region==='all'?'Todas':state.region)+' · Canal: '+esc(state.channel==='all'?'Todos':state.channel)+' · Subcanal: '+esc(state.subchannel==='all'?'Todos':state.subchannel)+'</summary><div class="indicator-controls">'+controls+'</div><p>Estos filtros adicionales aplican a los '+navigation.length+' apartados y su CSV; no cambian los reportes clásicos.</p></details>';
    let committee;
    if(section==='summary')html+=universePanel(universe(app,state),calculated.blocking,calculated.smart,app);
    committee=calculated.committee;
    if(section==='evolution') {
      html+=panel('📈 Evolución mensual de alertas generadas','Hasta seis meses del rango de fechas, hasta el mes seleccionado. Una misma escala compara recibidos, Alertas válidas y Alertas no válidas; se indican los pendientes. Son decisiones actuales por jornada, no cierres históricos.',
        monthlyChart(committee.trend)+chartDetails(table(['Mes','Alertas generadas','Alertas válidas','Alertas no válidas','Pendientes'],committee.trend.map(r=>row([esc(r.month)+(r.partial?' · Parcial':''),num(r.total),num(r.applies),num(r.rejects),num(r.pending)])))));
      html+=panel('Evolución de tiempos','Promedios por mes de carga. Las fechas sin hora se miden en días calendario.',timingChart(committee.timing)+chartDetails(table(['Mes de carga','Tiempo auditoría → generación de alerta','Generación de alerta → decisión aplicada'],committee.timing.map(r=>row([esc(r.month),time(r.intake),time(r.validation)])))));
    }
    if(state.month && section==='pending') {
      html+=inheritedPanel(committee,state.month,asOf);
      html+=panel('⏳ Detalle del rezago heredado','Pendientes actuales de jornadas anteriores al mes seleccionado. Se presentan aparte del total del mes.',
        '<button type="button" class="btn btn-outline btn-sm" data-committee-inherited '+(!committee.inherited.counts.pending?'disabled':'')+'>📥 Descargar pendientes heredados (CSV)</button>'+table(['ID','Jornada original','Estudio','País / región','Alertas pendientes'],Object.values(committee.inherited.backlog).flat().slice(0,100).map(a=>row([esc(a.id),esc(a.periodDate),esc(studyLabel(a.study)),esc(a.geography),num(a.pending)]))));
    }
    if(section==='summary') {
      html+=summaryBenchmark(result,universe(app,state),app);
      html+=signalPanel(result);
      html+=panel('La operación en una mirada',esc(narrative.headline),cards([
        ['Auditorías recibidas · sistema',num(result.audits),'IDs únicos cargados al portal','blue','🏬'],
        ['Alertas recibidas',num(c.total),'Sub-KPIs que requieren revisión','purple','📥'],
        ['Alertas revisadas',num(narrative.decided),pct(c.coverage)+' del total recibido','green','✅',c.coverage],
        ['Alertas pendientes',num(c.pending),num(narrative.pendingAudits)+' auditorías con alguna alerta pendiente','orange','⏳'],
        ['SLA promedio en validar','<span class="sla-card-value">'+esc(M.formatSla(result.sla.meanSeconds)).replace(/ (h|min|s)\b/g,'&nbsp;$1')+'</span>',num(result.sla.measured)+' auditorías medibles','cyan','⏱️']
      ])+decisionDonut(c)+'<p class="story-note">Una auditoría puede contener varias alertas. Revisadas = Alertas válidas + Alertas no válidas. Recibidas = revisadas + pendientes.</p>');
    }
    if(section==='pending') {
      html+=panel('Qué falta por revisar',num(c.pending)+' alertas pendientes en '+num(narrative.pendingAudits)+' auditorías. Consulta su distribución y los IDs pendientes por antigüedad.','<p class="story-note">Se excluyen las alertas pendientes sin fecha original válida, las cargas reemplazadas y los registros retirados. La gestión de descargar, reasignar o retirar pendientes se conserva en el panel de supervisión.</p>');
      const labels={recent:['0–6 días','blue','📅'],week:['7–14 días','orange','⏳'],old:['15 días o más','magenta','🚩'],future:['Fecha futura','cyan','🗓️']};
      const backlogRows=Object.entries(labels).map(([key,[name]])=>({name,count:result.backlog[key].length,total:result.backlog[key].reduce((sum,a)=>sum+a.pending,0)})).sort((a,b)=>b.total-a.total || a.name.localeCompare(b.name));
      html+=panel('Distribución del rezago','Grupos ordenados de mayor a menor por alertas pendientes con fecha original válida; antigüedad desde esa fecha.',groupedChart(backlogRows,[{key:'total',label:'Alertas pendientes',tone:'orange'}],{meta:r=>num(r.count)+' auditorías',unit:'alertas',kind:'backlog'})+chartDetails(table(['Antigüedad','Auditorías con pendientes','Alertas pendientes'],backlogRows.map(r=>row([r.name,num(r.count),num(r.total)])))));
      html+=panel('Pendientes por antigüedad','Días calendario desde la fecha original de auditoría, no desde la jornada de carga. Pulsa un grupo para consultar sus IDs.',
        '<div class="indicator-cards indicator-cards--backlog">'+Object.entries(labels).map(([k,[label,tone,symbol]],i)=>'<button type="button" class="stat-card indicator-card indicator-bucket indicator-tone-'+tone+'" style="--indicator-order:'+i+'" data-indicator-bucket="'+k+'" aria-pressed="false"><span class="indicator-card-main"><span class="stat-icon-wrapper indicator-card-icon" aria-hidden="true">'+symbol+'</span><span class="stat-details"><span class="stat-label">'+label+'</span><strong class="stat-value">'+num(result.backlog[k].length)+'</strong><small>Auditorías pendientes</small></span></span><span class="indicator-bucket-link">Ver detalle <span aria-hidden="true">→</span></span></button>').join('')+'</div><div data-indicator-backlog></div>');
    }
    if(section==='findings') {
      html+=panel('Qué confirmó la revisión','Porcentajes sobre todas las alertas recibidas en este alcance; los pendientes no se interpretan como descartados.',decisionDonut(c));
      html+=panel('Motivos de alertas no válidas','Ordenados por cantidad de alertas descartadas. Participación sobre las descartadas, no sobre el total recibido. La gráfica muestra hasta 15 motivos; la tabla y su CSV incluyen todos los motivos del filtro.',groupedChart(result.reasons.slice(0,15),[{key:'count',label:'Alertas no válidas',tone:'magenta'}],{meta:r=>pct(r.share)+' de las descartadas',unit:'alertas',kind:'ranking'})+chartDetails(table(['Motivo','Alertas descartadas','% de descartadas'],result.reasons.map(r=>row([esc(r.name),num(r.count),pct(r.share)])))));
      html+=panel('Alertas que más se generan','De mayor a menor por alertas generadas. La gráfica muestra las primeras 20 variables; la tabla y su CSV incluyen todas las variables del filtro.',outcomeChart(result.rejectedTypes.slice(0,20),{meta:r=>'Rechazo: '+pct(r.rejection)+' · Cobertura: '+pct(r.coverage)})+chartDetails(table(['Variable','Alertas generadas','Alertas válidas','Alertas no válidas','Pendientes','Rechazo','Cobertura'],result.rejectedTypes.map(r=>row([esc(r.name),num(r.total),num(r.applies),num(r.rejects),num(r.pending),pct(r.rejection),pct(r.coverage)])))));
      html+=auditorComparison(result,universe(app,state,{auditors:true}));
    }
    if(section==='timing') {
      html+=validationSlaPanel(result);
      html+=panel('Tiempo entre cada paso','Bases separadas: una muestra por auditoría para auditoría → generación de alerta; una por alerta decidida para generación de alerta → decisión aplicada. Horas solo con timestamps completos.',cards([['Tiempo auditoría → generación de alerta',time(result.timing.intake),'','blue','📤'],['Generación de alerta → decisión aplicada',time(result.timing.validation),'','purple','⏱️']],'timing'));
      html+=panel('Evolución de tiempos por mes de carga','Promedios en días. Fechas sin hora se miden en días calendario; no se estima una hora inexistente.',timingChart(result.timing.monthly)+chartDetails(table(['Mes de carga','Tiempo auditoría → generación de alerta','Generación de alerta → decisión aplicada'],result.timing.monthly.map(r=>row([r.month,time(r.intake),time(r.validation)])))));
      html+='<p class="story-note">Los dos tramos entre eventos se presentan aparte del SLA de revisión. No se calcula un porcentaje de cumplimiento sin un plazo objetivo definido.</p>';
    }
    if(section==='comparison') {
      html+=territoryComparison(result,universe(app,state),scope);

      html+=channelSegmentComparison(result,universe(app,state,{channelSegments:true}),scope);
    }
    const moduleLabel=module==='smart'?'SMART':module==='all'?'BLOQUEANTES + SMART':'BLOQUEANTES';
    html=html.replace(/· BLOQUEANTES/g,'· '+moduleLabel).replace('No incluye Smart.','Módulo: '+moduleLabel+'. En Consolidado, cada caso y alerta se cuenta por módulo.').replace('resumen de Bloqueantes','resumen de esta lectura').replace(jump('decisions','Preparar decisiones'),'');
    const reportContextReady=app.areReportDimensionsReady?.(audits)!==false;
    if(!reportContextReady)html='<p class="story-note" role="status">'+(app.benchmarkCountryRetryAfter
      ?'No fue posible contrastar región y canal con Databricks. Pulsa Actualizar totales para reintentar; las descargas esperan el cruce.'
      :'Contrastando región y canal con Databricks; las descargas estarán disponibles al terminar.')+'</p>'+html;
    target.innerHTML=html;
    bindChartTableExports(target,{suffix:[module || 'blocking',state.month || from,to].filter(Boolean).join('-')});
    bindScopeControls();
    target.querySelectorAll('[data-summary-study]').forEach(button=>button.addEventListener('click',()=>{
      const study=button.dataset.summaryStudy,expanded=button.getAttribute('aria-expanded')!=='true';
      button.setAttribute('aria-expanded',String(expanded));
      if(expanded)app.expandedSummaryStudies.add(study);else app.expandedSummaryStudies.delete(study);
      target.querySelectorAll('[data-summary-parent]').forEach(row=>{if(row.dataset.summaryParent===study)row.hidden=!expanded;});
    }));
    target.querySelector('[data-universe-refresh]')?.addEventListener('click',async()=>{
      if(app.backend?.loadAuditReportContext) {
        app.benchmarkReportCheckedKeys=new Set();app.benchmarkCountryRows=[];
        app.benchmarkCountryIndex=null;app.benchmarkCountryRetryAfter=0;
      }
      app.databricksTotalsCache?.forEach(entry=>{entry.loadedAt=0;entry.attemptedAt=0;entry.retryCount=0;clearTimeout(entry.retryTimer);});app.renderReportsView();
      try {await app.ensureIndicatorHistoriesLoaded?.({force:true});}
      catch(error) {console.error('No fue posible actualizar los recibidos:',error);}
      app.renderReportsView();
    });
    target.querySelectorAll('[data-story-section]').forEach(el=>el.addEventListener('click',()=>{if(el.dataset.storySection===section)return;app[sectionKey]=el.dataset.storySection;render(app,audits,historyAudits,snapshot,receiptAudits);target.querySelector('[aria-current="page"]')?.focus({preventScroll:true});}));
    target.querySelectorAll('[data-indicator-filter]').forEach(el=>el.addEventListener('change',()=>{state[el.dataset.indicatorFilter]=el.value;render(app,audits,historyAudits,snapshot,receiptAudits);}));
    target.querySelector('[data-committee-inherited]')?.addEventListener('click',()=>download(['ID auditoría','Jornada original','Estudio','País','Región','Sub-KPI','Estado actual'],committee.inherited.alerts.filter(a=>a.decision==='pendiente').map(a=>[a.id,a.periodDate,studyLabel(a.study),a.country,a.region,a.name,'Pendiente']),'Pendientes-heredados-antes-'+state.month+'.csv'));
    target.querySelectorAll('[data-indicator-bucket]').forEach(el=>el.addEventListener('click',()=>{
      target.querySelectorAll('[data-indicator-bucket]').forEach(button=>button.setAttribute('aria-pressed',String(button===el)));
      target.querySelector('[data-indicator-backlog]').innerHTML=table(['ID auditoría','Fecha original','Estudio','País','Días','Alertas pendientes'],result.backlog[el.dataset.indicatorBucket].slice(0,100).map(a=>row([esc(a.id),esc(a.auditDate || 'Sin fecha'),esc(studyLabel(a.study)),esc(a.country),a.age==null?'—':num(a.age),num(a.pending)])))+'<p>Hasta 100 filas; descarga el detalle completo en CSV.</p>';
    }));
    const auditIndex = new Map(inputs.map(a=>[JSON.stringify([a.module,a.id,a.study]),a]));
    const exportButton=target.querySelector('[data-indicator-download]');
    if(exportButton) {
      const modules=module==='all'?['blocking','smart']:[module || 'blocking'];
      const historyReady=!app.backend?.configured || modules.every(key=>Array.isArray(app.auditHistoryByModule?.[key]) && !app.auditHistoryErrors?.[key]);
      exportButton.disabled=!c.total || !historyReady || !reportContextReady;
      exportButton.title=!reportContextReady?'Contrastando región y canal con Databricks…':historyReady?'Una fila por alerta generada, según los filtros activos. El SLA total de la auditoría se repite en sus alertas; no se suma por KPI.':'Consultando el histórico de alertas…';
    }
    target.querySelector('[data-indicator-download]')?.addEventListener('click',()=>download(['Módulo','ID auditoría','Jornada','Fecha auditoría original','Fecha de carga','Fecha de decisión','Estudio','País','Región','Canal','Subcanal','Auditor','Sub-KPI','Decisión','Tipificación','Segmento','Validador','Código validador','Inicio de validación','Fin de validación',...Object.keys(M.validationSlaExport({}))],result.alerts.map(a=>{
      const source=auditIndex.get(JSON.stringify([a.module,a.id,a.study]));
      return [a.module==='smart'?'Smart':'Bloqueantes',a.id,a.periodDate,source?.auditDate,source?.alertUploadedAt,a.validatedAt,studyLabel(a.study),a.country,a.region,a.channel,a.subchannel,a.auditor,a.name,decisionLabel(a.decision),a.reason,a.segment,source?.validatorName || source?.validatorId,source?.validatorCode,source?.startedAt,source?.completedAt,...Object.values(M.validationSlaExport(source || {},asOf))];
    }),'Indicadores-'+(module || 'blocking')+'-'+asOf+'.csv'));
  }
  root.PortalIndicators={adapt,reportDimensions,canonical,render,csv,download,alertExport,signalPanel,receiptShare,auditorComparisonData,auditorComparison,territoryComparisonData,territoryComparison,channelSegmentComparisonData,channelSegmentComparison,summaryBenchmarkData,summaryBenchmark,universePanel,studyLabel,esc,table,row,panel,story,decisionBar,journey,committeeJourney,committeeData,committeeSection,inheritedPanel,databricksAuditor,macroData,macroDashboard,groupedChart,outcomeChart,decisionDonut,monthlyTrend,monthlyChart,timingChart,chartTableData,bindChartTableExports};
  if(typeof module!=='undefined')module.exports=root.PortalIndicators;
})(typeof globalThis!=='undefined'?globalThis:this);
