(function (root) {
  const M = root.PortalIndicatorMetrics;
  const studyLabel = value => root.PortalStudyLabels?.getStudyDisplayName(value) || value;
  const number = value => new Intl.NumberFormat('es-CO').format(value);
  const percent = value => value == null ? 'Sin base' : number(Math.round(value * 1000) / 10) + '%';
  const palette = { navy: [36,51,95], blue: [13,92,171], green: [20,168,59], red: [211,43,73], amber: [169,105,0], gray: [99,112,132], pink: [248,56,117] };

  function alertBreakdown(result) {
    return [...result.rejectedTypes].sort((a,b)=>b.total-a.total || a.name.localeCompare(b.name,'es'));
  }

  function signals(result) {
    const c = result.counts;
    const pending = Object.values(result.backlog).flat();
    const dated = pending.filter(a => a.age != null && a.age >= 0);
    const old = result.backlog.old.length;
    const share = dated.length ? old / dated.length : null;
    return [
      { name: 'Avance de revisión', value: percent(c.coverage), tone: c.coverage == null ? 'gray' : c.coverage >= .95 ? 'green' : c.coverage >= .8 ? 'amber' : 'red',
        label: c.coverage == null ? 'Sin base' : c.coverage >= .95 ? 'Buen avance' : c.coverage >= .8 ? 'En seguimiento' : 'Requiere atención',
        rule: 'Verde: 95% o más. Amarillo: 80% a menos de 95%. Rojo: menos de 80%.',
        detail: number(c.applies + c.rejects) + ' revisadas de ' + number(c.total) + ' alertas.' },
      { name: 'Pendientes de 15 días o más', value: number(old), tone: !c.total || pending.length && !dated.length ? 'gray' : !old ? 'green' : share <= .1 ? 'amber' : 'red',
        label: !c.total || pending.length && !dated.length ? 'Sin base de antigüedad' : !old ? 'Sin pendientes antiguos' : share <= .1 ? 'En seguimiento' : 'Requiere atención',
        rule: 'Verde: ninguno. Amarillo: hasta 10% de pendientes con fecha válida. Rojo: más de 10%.',
        detail: number(old) + ' de ' + number(dated.length) + ' auditorías pendientes con fecha válida; ' + number(pending.length - dated.length) + ' sin antigüedad calculable.' }
    ];
  }

  function buildSnapshot(app) {
    const U = root.PortalIndicators;
    const module = app.currentView === 'visualizations' ? app.getVisualizationModuleFilter() : app.currentModule;
    const context = [...(app.adminExternalAnalysis?.alertRecords || []), ...(app.benchmarkCountryRows || [])];
    const asOf = new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const state = {region:'all',channel:'all',subchannel:'all',...(app.indicatorFilters || {}),month:''};
    const audits = app.getFilteredAuditsForReports();
    const inputs = U.adapt(audits,context,a=>app.getReportCountry(a),module);
    const result = M.compute(inputs,{...state,asOf,from:app.visualizationDateFrom || '',to:app.visualizationDateTo || asOf});
    const rangeInputs = U.adapt(app.getFilteredAuditsForReports(app.getReportAuditSource(),{ignoreMonth:true}),context,a=>app.getReportCountry(a),module);
    const first = rangeInputs.map(a=>a.periodDate).filter(Boolean).sort()[0];
    const range = M.compute(rangeInputs,{...state,asOf,from:app.visualizationDateFrom || (first ? first.slice(0,7)+'-01' : ''),to:app.visualizationDateTo || asOf});
    const month = app.selectedMetricsMonth === 'all' ? '' : app.selectedMetricsMonth || '';
    const labels = [module === 'all' ? 'Bloqueantes + Smart' : module === 'smart' ? 'Smart' : 'Bloqueantes',
      'Estudio: '+((app.selectedStudies || ['ALL']).includes('ALL') ? 'Todos' : app.selectedStudies.map(studyLabel).join(', ')),
      'País: '+(app.selectedMetricsCountry === '__missing__' ? 'Sin país identificado' : app.selectedMetricsCountry || 'all').replace(/^all$/,'Todos'),
      'Mes: '+(month || 'Todos'), 'Desde: '+(app.visualizationDateFrom || 'Inicio del histórico'), 'Hasta: '+(app.visualizationDateTo || asOf),
      ...['region','channel','subchannel'].filter(k=>state[k]!=='all').map(k=>({region:'Región',channel:'Canal',subchannel:'Subcanal'}[k])+': '+state[k])];
    return {asOf,scope:labels.join(' | '),result,trend:U.monthlyTrend(range,month || asOf.slice(0,7),6),signals:signals(result),alertTypes:alertBreakdown(result)};
  }

  // Compose vector charts and text directly; no DOM screenshot or canvas.
  function buildPdf(JsPDF, snapshot) {
    const pdf = new JsPDF({unit:'mm',format:'a4',orientation:'landscape'});
    const width = pdf.internal.pageSize.getWidth(), height = pdf.internal.pageSize.getHeight(), margin = 14;
    const usable = width - margin * 2;
    const clean = value => String(value ?? '').replace(/[•–—]/g,'-').replace(/→/g,'->').replace(/\p{Extended_Pictographic}/gu,'').trim();
    const write = (text,x,y,size=10,color='navy',bold=false,maxWidth=null) => {
      pdf.setFont('helvetica',bold?'bold':'normal');pdf.setFontSize(size);pdf.setTextColor(...palette[color]);
      pdf.text(maxWidth ? pdf.splitTextToSize(clean(text),maxWidth) : clean(text),x,y);
    };
    const frame = title => {
      pdf.setFillColor(...palette.navy);pdf.rect(0,0,width,26,'F');
      pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(16);pdf.text('dichter & neira | '+title,margin,17);
      write('Corte: '+snapshot.asOf+' | Decisiones actuales por jornada',margin,33,9,'gray');
      write(snapshot.scope,margin,40,9,'gray',false,usable);
    };
    const page = title => {pdf.addPage();frame(title);};
    const bar = (value,max,x,y,w,tone,h=3) => {
      pdf.setFillColor(238,242,247);pdf.rect(x,y,w,h,'F');
      if(max>0 && value>0){pdf.setFillColor(...palette[tone]);pdf.rect(x,y,Math.max(.5,w*value/max),h,'F');}
    };
    const c=snapshot.result.counts, r=snapshot.result;
    frame('Indicadores de validación');
    const metrics=[['Auditorías con alertas',r.audits],['Alertas generadas',c.total],['Alertas válidas',c.applies],['Alertas no válidas',c.rejects],['Pendientes',c.pending],
      ['SLA promedio en validar',M.formatSla(r.sla.meanSeconds),number(r.sla.measured)+' medibles']];
    const cardWidth=(usable-5*5)/6;
    metrics.forEach(([label,value,hint],i)=>{
      const x=margin+i*(cardWidth+5);pdf.setFillColor(245,247,250);pdf.roundedRect(x,59,cardWidth,32,3,3,'F');
      write(label,x+4,67,8,'gray',false,cardWidth-8);write(typeof value==='number'?number(value):value,x+4,81,15,'blue',true);
      if(hint)write(hint,x+4,87,7,'gray');
    });
    write('Semáforos de revisión',margin,99,13,'navy',true);
    snapshot.signals.forEach((signal,i)=>{
      const x=margin+i*(usable/2+3), w=usable/2-3;
      pdf.setDrawColor(218,225,235);pdf.roundedRect(x,105,w,44,3,3,'S');
      pdf.setFillColor(...palette[signal.tone]);pdf.circle(x+6,113,2,'F');
      write(signal.name,x+12,114,11,'navy',true);write(signal.value+' | '+signal.label,x+5,124,11,signal.tone,true);
      write(signal.detail,x+5,131,8,'gray',false,w-10);write(signal.rule,x+5,141,8,'gray',false,w-10);
    });
    write('Composición de alertas recibidas',margin,161,12,'navy',true);
    const segments=[['Alertas válidas',c.applies,'green'],['Alertas no válidas',c.rejects,'pink'],['Pendientes',c.pending,'amber']];
    let offset=margin;
    segments.forEach(([label,value,tone],i)=>{
      const w=c.total?usable*value/c.total:0;
      if(w){pdf.setFillColor(...palette[tone]);pdf.rect(offset,166,w,7,'F');offset+=w;}
      write(label+': '+number(value)+' ('+percent(M.ratio(value,c.total))+')',margin+i*usable/3,181,10,tone,true);
    });
    write('Revisadas = Alertas válidas + Alertas no válidas. Recibidas = revisadas + pendientes. Criterios de semáforo orientativos.',margin,190,8,'gray');

    page('Evolución mensual');
    write('Alertas generadas, válidas y no válidas',margin,60,14,'navy',true);
    write('Hasta seis meses dentro del rango, hasta el mes seleccionado. Se conserva el contexto de meses anteriores.',margin,68,9,'gray');
    const max=Math.max(1,...snapshot.trend.map(row=>row.total));
    if(!snapshot.trend.length)write('Sin registros para el alcance seleccionado.',margin,85,11,'gray');
    snapshot.trend.forEach((row,i)=>{
      const y=81+i*17;
      write(row.month+(row.partial?' (parcial)':''),margin,y+4,10,'navy',true);
      write(number(row.pending)+' pendientes',margin,y+9,8,'gray');
      [['Recibidas',row.total,'blue'],['Alertas válidas',row.applies,'green'],['Alertas no válidas',row.rejects,'pink']].forEach(([label,value,tone],j)=>{
        const yy=y+j*4.5;write(label,margin+47,yy+3,8,'gray',false,37);bar(value,max,margin+86,yy,usable-105,tone,3);write(number(value),width-margin-14,yy+3,8,tone,true);
      });
    });
    write('No se interpretan meses sin datos como cero. Son cohortes de jornada con decisiones actuales, no cierres históricos.',margin,190,8,'gray');

    page('Comparativas por estudio y territorio');
    write('Composición de las alertas por territorio',margin,60,14,'navy',true);
    write('Hasta 12 grupos con mayor volumen. País para KO; región para KO Tradicional CHILE y Lindley. Verde: Alertas válidas; rosa: Alertas no válidas; amarillo: pendientes.',margin,68,9,'gray',false,usable);
    const groups=[...r.benchmark].sort((a,b)=>b.total-a.total||a.study.localeCompare(b.study)).slice(0,12);
    const groupMax=Math.max(1,...groups.map(row=>row.total));
    if(!groups.length)write('Sin registros para el alcance seleccionado.',margin,86,11,'gray');
    groups.forEach((row,i)=>{
      const y=80+i*9;
      write(studyLabel(row.study)+' | '+row.geography,margin,y,8,'navy',true,91);
      let x=margin+96;
      [['applies','green'],['rejects','pink'],['pending','amber']].forEach(([key,tone])=>{
        const w=(usable-151)*row[key]/groupMax;
        if(w){pdf.setFillColor(...palette[tone]);pdf.rect(x,y-2.5,w,3,'F');x+=w;}
      });
      write(number(row.total)+' | '+percent(row.coverage)+' revisado',width-margin-48,y,8,'gray');
    });

    const alertTypes=snapshot.alertTypes || alertBreakdown(r);
    const alertMax=Math.max(1,...alertTypes.map(row=>row.total));
    let alertY;
    const alertPage=()=>{
      page('Desglose por tipo de alerta');
      write('¿Qué alertas se reciben con mayor frecuencia?',margin,60,14,'navy',true);
      write('Ordenadas de mayor a menor cantidad recibida. Se incluyen todos los tipos del alcance seleccionado.',margin,68,9,'gray');
      write('Recibidas = Alertas válidas + Alertas no válidas + pendientes. Escala común de barras: 0 a '+number(alertMax)+' Alertas generadas.',margin,73,8,'gray');
      write('Tipo de alerta / Sub-KPI',margin,78,9,'navy',true);
      write('Alertas válidas | Alertas no válidas | Pendientes',margin+86,78,8,'gray');
      [['Recibidas',174,'blue'],['Alertas válidas',199,'green'],['Alertas no válidas',224,'pink'],['Pendientes',249,'amber']].forEach(([label,x,tone])=>write(label,margin+x,78,8,tone,true,24));
      alertY=88;
    };
    alertPage();
    if(!alertTypes.length)write('Sin alertas para el alcance seleccionado.',margin,alertY,11,'gray');
    alertTypes.forEach((row,i)=>{
      pdf.setFont('helvetica','normal');pdf.setFontSize(9);
      const label=pdf.splitTextToSize(clean((i+1)+'. '+row.name),82);
      const rowHeight=Math.max(11,label.length*4+4);
      if(alertY+rowHeight>height-18)alertPage();
      write((i+1)+'. '+row.name,margin,alertY,9,'navy',false,82);
      let x=margin+86;
      [['applies','green'],['rejects','pink'],['pending','amber']].forEach(([key,tone])=>{
        const w=80*row[key]/alertMax;
        if(w){pdf.setFillColor(...palette[tone]);pdf.rect(x,alertY-2.5,w,4,'F');x+=w;}
      });
      [['total',174,'blue'],['applies',199,'green'],['rejects',224,'pink'],['pending',249,'amber']].forEach(([key,x,tone])=>write(number(row[key]),margin+x,alertY,10,tone,true));
      pdf.setDrawColor(231,236,243);pdf.line(margin,alertY+rowHeight-5,width-margin,alertY+rowHeight-5);
      alertY+=rowHeight;
    });

    page('Hallazgos y tiempos');
    write('Motivos más frecuentes de Alertas no válidas',margin,61,13,'navy',true);
    if(!r.reasons.length)write('Sin alertas descartadas en este alcance.',margin,73,10,'gray');
    const reasonMax=Math.max(1,...r.reasons.map(row=>row.count));
    r.reasons.slice(0,5).forEach((row,i)=>{
      const y=74+i*12;write(row.name,margin,y,9,'navy',false,120);
      bar(row.count,reasonMax,margin+125,y-3,usable-170,'pink',4);write(number(row.count)+' | '+percent(row.share),width-margin-40,y,9,'gray');
    });
    write('Tiempos promedio',margin,146,13,'navy',true);
    [['Tiempo auditoría → generación de alerta',r.timing.intake],['Generación de alerta → decisión aplicada',r.timing.validation]].forEach(([label,item],i)=>{
      write(label,margin+i*usable/2,158,10,'navy',true,usable/2-8);
      write(item.meanDays==null?'Sin muestras':number(Math.round(item.meanDays*100)/100)+' días | '+number(item.measured)+' muestras',margin+i*usable/2,169,12,'blue');
      write('Sin fecha: '+item.missing+' | Inválidas: '+item.invalid+' | Futuras: '+item.future,margin+i*usable/2,179,8,'gray');
    });
    let slaY;
    const slaPage=()=>{
      page('SLA de validación por validador');
      [['SLA promedio en validar',r.sla.meanSeconds],['Mediana de validación',r.sla.medianSeconds],['P90 de validación',r.sla.p90Seconds]].forEach(([label,value],i)=>{
        const x=margin+i*(usable/3+2),w=usable/3-4;
        pdf.setFillColor(245,247,250);pdf.roundedRect(x,57,w,27,3,3,'F');
        write(label,x+4,65,9,'gray');write(M.formatSla(value),x+4,77,17,'blue',true);
      });
      write('Inicio de revisión a cierre de auditoría; incluye pausas. Una muestra por auditoría y módulo, sin multiplicar por KPIs.',margin,91,9,'gray');
      write(number(r.sla.measured)+' medibles de '+number(r.sla.completed)+' completadas. Sin hora: '+r.sla.missing+' | Inválidas: '+r.sla.invalid+' | Futuras: '+r.sla.future+'. P90: al menos 90% de las mediciones no supera ese tiempo.',margin,97,8,'gray',false,usable);
      [['Validador',0],['Completadas',88],['Con SLA',117],['Promedio',146],['Mediana',186],['P90',226]].forEach(([label,x])=>write(label,margin+x,109,9,'navy',true));
      slaY=119;
    };
    slaPage();
    if(!r.sla.validators.length)write('Sin auditorías completadas en este alcance.',margin,slaY,11,'gray');
    r.sla.validators.forEach(v=>{
      const label=v.name+(v.code?' | '+v.code:'');
      pdf.setFont('helvetica','normal');pdf.setFontSize(9);
      const rowHeight=Math.max(12,pdf.splitTextToSize(clean(label),80).length*4+5);
      if(slaY+rowHeight>height-18)slaPage();
      write(label,margin,slaY,9,'navy',false,80);
      [[v.completed,88],[v.measured,117],[M.formatSla(v.meanSeconds),146],[M.formatSla(v.medianSeconds),186],[M.formatSla(v.p90Seconds),226]].forEach(([value,x])=>write(typeof value==='number'?number(value):value,margin+x,slaY,9,'gray'));
      pdf.setDrawColor(231,236,243);pdf.line(margin,slaY+rowHeight-5,width-margin,slaY+rowHeight-5);
      slaY+=rowHeight;
    });
    const pages=pdf.internal.getNumberOfPages();
    for(let i=1;i<=pages;i++){
      pdf.setPage(i);pdf.setDrawColor(221,227,236);pdf.line(margin,height-12,width-margin,height-12);
      write('Portal de validación | Indicadores filtrados',margin,height-6,8,'gray');write(i+' / '+pages,width-margin-15,height-6,8,'gray');
    }
    return pdf;
  }
  root.PortalIndicatorReport={signals,buildSnapshot,buildPdf,alertBreakdown};
  if(typeof module!=='undefined')module.exports=root.PortalIndicatorReport;
})(typeof globalThis!=='undefined'?globalThis:this);
