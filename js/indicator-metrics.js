(function (root) {
  const DAY = 86400000;
  const eventDayFormat = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
  const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const text = v => String(v ?? '').trim();
  const ratio = (n, d) => d > 0 ? n / d : null;
  function isReportAudit(audit) {
    const sourceStudies=[audit?.study,audit?.estudio,audit?.originalStudy];
    const meta=audit?.meta || {};
    for(const key of ['Estudio','estudio','ESTUDIO','Study','study','STUDY','Survey','survey','SURVEY'])sourceStudies.push(meta[key]);
    return !sourceStudies.some(value=>/(^|[^a-z0-9])dsd([^a-z0-9]|$)/i.test(text(value)));
  }
  function normalizeRegion(value) {
    const region = text(value).replace(/\s+/g, ' ');
    if (!region || /^(null|undefined|n\/?a|sin regi[oó]n(?: identificada)?|-|\d+(\.\d+)?)$/i.test(region)) return '';
    // Fold vowel accents and case, preserving Ñ as a distinct letter.
    return region.normalize('NFD').replace(/\u0301/g, '').normalize('NFC').toLocaleUpperCase('es');
  }
  function dateKey(value) {
    const raw = text(value);
    // The uploaded bases can retain Excel's 1900-system serial dates. Match
    // the range already used by the export importer and keep their local day;
    // the fractional part has no timezone, so it cannot supply exact hours.
    if (/^\d{5}(?:[.,]\d+)?$/.test(raw)) {
      const serial=Number(raw.replace(',','.'));
      if (serial>=20000 && serial<=70000) return new Date(Date.UTC(1899,11,30)+Math.floor(serial)*DAY).toISOString().slice(0,10);
    }
    let candidate = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
    if (!candidate) {
      const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:$|[ T])/);
      if (dmy) candidate = [null, dmy[3], dmy[2], dmy[1]];
    }
    if (!candidate) return null;
    const iso = `${candidate[1]}-${candidate[2]}-${candidate[3]}`;
    const parsed = new Date(iso + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
  }
  function weekKey(date) {
    const key = dateKey(date);
    if (!key) return null;
    const d = new Date(key + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  }
  function shiftDate(date, days) { return new Date(new Date(date + 'T00:00:00Z').getTime() + days * DAY).toISOString().slice(0, 10); }
  function monthBounds(month) {
    const start = month + '-01';
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return { start, end: d.toISOString().slice(0, 10) };
  }
  function previousMonth(month) {
    const d = new Date(month + '-01T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  }
  function normalizeStudy(value) {
    const s = norm(value);
    if (/ko[ _]trad[ _]ch([ _]|$)|chile|embonor/.test(s)) return 'Chile';
    if (/lindley/.test(s)) return 'Lindley';
    if (/moderno/.test(s)) return 'KO Moderno CAM';
    if (/trad/.test(s)) return 'KO Tradicional CAM';
    if (/chile|embonor/.test(s)) return 'Chile';
    return text(value) || 'Sin estudio';
  }
  function normalizeCountry(value, study) {
    if (study === 'Lindley') return 'Perú';
    if (study === 'Chile') return 'Chile';
    const countries = { 'costa rica':'Costa Rica', 'el salvador':'El Salvador', guatemala:'Guatemala', honduras:'Honduras', nicaragua:'Nicaragua', panama:'Panamá', 'republica dominicana':'República Dominicana', peru:'Perú', chile:'Chile', colombia:'Colombia', ecuador:'Ecuador', mexico:'México', argentina:'Argentina', bolivia:'Bolivia', brasil:'Brasil', brazil:'Brasil', uruguay:'Uruguay', paraguay:'Paraguay', venezuela:'Venezuela', belice:'Belice', belize:'Belice', 'estados unidos':'Estados Unidos', canada:'Canadá', haiti:'Haití', jamaica:'Jamaica' };
    const s = norm(value);
    if (/guatemala/.test(s)) return 'Guatemala';
    return countries[s] || 'Sin país identificado';
  }
  function decision(v) { const s = norm(v).replace(/[_-]/g, ' '); return s === 'aplica' ? 'aplica' : s === 'no aplica' ? 'no_aplica' : 'pendiente'; }
  function eventStamp(value) {
    const raw = text(value);
    const day = dateKey(raw);
    if (!day) return null;
    if (/^\d{5}(?:[.,]\d+)?$/.test(raw)) return {day,ms:null};
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/.test(raw.slice(11))) return null;
      return { day:eventDayFormat.format(new Date(ms)), ms };
    }
    // Una fecha sin hora no se convierte en una hora de medianoche ficticia.
    if (/^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/.test(raw)) return { day, ms:null };
    return null;
  }
  function interval(start, end, asOf) {
    if (!start || !end) return { state:'missing' };
    if (start.day > asOf || end.day > asOf) return { state:'future' };
    const days = Math.round((new Date(end.day) - new Date(start.day)) / DAY);
    const hours = start.ms !== null && end.ms !== null ? (end.ms - start.ms) / 3600000 : null;
    if (days < 0 || hours !== null && hours < 0) return { state:'invalid' };
    return { state:'valid', days, hours };
  }
  function durationStats(pairs) {
    const valid=pairs.filter(p=>p.state==='valid'), exact=valid.filter(p=>p.hours!==null);
    const average=(list,key)=>list.length ? list.reduce((n,p)=>n+p[key],0)/list.length : null;
    return { measured:valid.length, exact:exact.length, dateOnly:valid.length-exact.length,
      missing:pairs.filter(p=>p.state==='missing').length, invalid:pairs.filter(p=>p.state==='invalid').length,
      future:pairs.filter(p=>p.state==='future').length, meanDays:average(valid,'days'), meanHours:average(exact,'hours') };
  }
  function auditValidationSla(audit, asOf=eventDayFormat.format(new Date())) {
    if (!['completada','completed'].includes(audit.validationStatus || audit.status)) return {state:'pending',seconds:null};
    const rawStart=audit.startedAt,rawEnd=audit.completedAt;
    const start=eventStamp(rawStart),end=eventStamp(rawEnd);
    if ((rawStart && !start) || (rawEnd && !end)) return {state:'invalid',seconds:null};
    if (!start || !end || start.ms===null || end.ms===null) return {state:'missing',seconds:null};
    const span=interval(start,end,asOf);
    return {state:span.state,seconds:span.state==='valid'?(end.ms-start.ms)/1000:null};
  }
  function formatSla(seconds) {
    if (seconds==null || !Number.isFinite(seconds)) return 'Sin muestras';
    const value=Math.round(seconds),hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60);
    return hours ? hours+' h '+minutes+' min' : minutes ? minutes+' min '+value%60+' s' : value+' s';
  }
  function validationSlaExport(audit,asOf) {
    const sla=auditValidationSla(audit,asOf);
    return {'SLA total de validación (seg)':sla.seconds ?? '',
      'SLA total de validación (min)':sla.seconds==null?'':Math.round(sla.seconds/60*10000)/10000,
      'Estado de medición SLA':({valid:'Medido',pending:'Sin completar',missing:'Sin inicio o cierre con hora',invalid:'Fechas inválidas',future:'Posterior al corte'})[sla.state]};
  }
  function validationSlaStatistics(audits,asOf) {
    const completed=audits.filter(a=>['completada','completed'].includes(a.validationStatus || a.status));
    const measurements=completed.map(a=>({audit:a,...auditValidationSla(a,asOf)}));
    const summarize=items=>{
      const values=items.filter(m=>m.state==='valid').map(m=>m.seconds).sort((a,b)=>a-b),n=values.length;
      const totalSeconds=n?values.reduce((sum,value)=>sum+value,0):null;
      return {completed:items.length,measured:n,missing:items.filter(m=>m.state==='missing').length,
        invalid:items.filter(m=>m.state==='invalid').length,future:items.filter(m=>m.state==='future').length,
        totalSeconds,meanSeconds:n?totalSeconds/n:null,
        medianSeconds:n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null,
        p90Seconds:n?values[Math.ceil(n*.9)-1]:null,minSeconds:n?values[0]:null,maxSeconds:n?values[n-1]:null};
    };
    const groups=new Map();
    for(const item of measurements){
      const a=item.audit,id=a.validatorId || '',name=a.validatorName || id || 'Sin validador identificado';
      const key=id?'id:'+id:'name:'+name.toLocaleLowerCase('es');
      if(!groups.has(key))groups.set(key,{id,name,code:a.validatorCode || '',items:[]});
      groups.get(key).items.push(item);
    }
    return {...summarize(measurements),validators:[...groups.values()].map(({items,...v})=>({...v,...summarize(items)}))
      .sort((a,b)=>b.completed-a.completed || b.measured-a.measured || a.name.localeCompare(b.name,'es'))};
  }
  function timing(audits, asOf) {
    const months=new Map(), intake=[], validation=[];
    for (const a of audits) {
      const first=interval(a.auditEvent,a.alertUploadedEvent,asOf);
      intake.push(first);
      const month=a.alertUploadedEvent?.day.slice(0,7);
      if (month && a.alertUploadedEvent.day<=asOf && !months.has(month)) months.set(month,{month,intake:[],validation:[]});
      if (month && months.has(month)) months.get(month).intake.push(first);
      for (const k of a.kpis.filter(k=>k.decision!=='pendiente')) {
        const second=interval(a.alertUploadedEvent,k.validatedEvent,asOf);
        validation.push(second);
        if (month && months.has(month)) months.get(month).validation.push(second);
      }
    }
    return { intake:durationStats(intake), validation:durationStats(validation),
      monthly:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(m=>({month:m.month,intake:durationStats(m.intake),validation:durationStats(m.validation)})) };
  }
  function normalizeAudits(input) {
    if (!Array.isArray(input)) throw new Error('Se espera un arreglo de auditorías.');
    const records = new Map();
    for (const row of input) {
      if(!isReportAudit(row))continue;
      if (!row || !/^\d+$/.test(text(row.id))) throw new Error('Cada auditoría debe tener un ID numérico.');
      const sourceModule=row._module || 'blocking';
      if (!['blocking','smart'].includes(sourceModule)) throw new Error('Módulo de alertas no válido.');
      const study = normalizeStudy(row.study || row.estudio || row.modelo);
      const periodDate = dateKey(row.periodDate || row._batchOperationDate || row.fecha || row.auditDate);
      const auditDate = eventStamp(row.auditAt || row.auditDate)?.day || null; // nunca sustituir por fecha de carga/jornada
      const month = periodDate?.slice(0, 7) || null;
      const key = JSON.stringify([sourceModule, study, text(row.id)]);
      if (records.has(key)) throw new Error(`ID ${row.id} duplicado en el mismo estudio. Carga una sola versión de cada auditoría, incluso entre meses.`);
      if (!Array.isArray(row.kpis)) throw new Error(`La auditoría ${row.id} no contiene una lista de KPIs.`);
      const country = normalizeCountry(row.country || row.pais, study);
      const alertUploadedEvent=eventStamp(row.alertUploadedAt || row.alertUploadedDate || row._batchUploadedAt);
      const auditEvent=eventStamp(row.auditAt || row.auditDate);
      const kpis = row.kpis.filter(k => k.needsReview === true).map(k => ({
        name: text(k.variable || k.kpiName || k.name) || 'Sin variable',
        key: text(k.name), decision: decision(k.decision ?? row.validationResults?.[k.name]?.status),
        reason: text(k.reason ?? row.validationResults?.[k.name]?.tipificacion),
        validatedAt:text(k.validatedAt || row.validationResults?.[k.name]?.supervisorResolvedAt || row.validationResults?.[k.name]?.decisionAt),
        validatedEvent:eventStamp(k.validatedAt || row.validationResults?.[k.name]?.supervisorResolvedAt || row.validationResults?.[k.name]?.decisionAt)
      }));
      records.set(key, { id: text(row.id), module:sourceModule, study, country,
        geography: ['Chile','Lindley'].includes(study) ? normalizeRegion(row.region) || 'Sin región identificada' : country,
        pdv: text(row.pdv || row.idPDV),
        auditor: text(row.auditor || row.usuario), region:normalizeRegion(row.region), channel:text(row.channel || row.canal),
        subchannel:text(row.subchannel || row.subcanal), segment:text(row.segment ?? row.segmento), periodDate, auditDate, auditEvent,
        startedAt:row.startedAt || '',completedAt:row.completedAt || '',validationStatus:row.validationStatus || row.status || '',
        validatorId:text(row.validatorId || row.assignedValidatorId),validatorName:text(row.validatorName || row._validatorName || row.validadorNombre),validatorCode:text(row.validatorCode || row._validatorCode),
        alertUploadedAt:text(row.alertUploadedAt || row.alertUploadedDate || row._batchUploadedAt), alertUploadedEvent, month, kpis });
    }
    return [...records.values()];
  }
  function parseCSV(textValue) {
    const data = String(textValue).replace(/^\uFEFF/, '');
    const first = data.split(/\r?\n/)[0] || '';
    const delimiters = [';', ',', '\t'];
    const delimiter = delimiters.sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '"') { if (quoted && data[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (ch === delimiter && !quoted) { row.push(cell); cell = ''; }
      else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && data[i + 1] === '\n') i++;
        row.push(cell); if (row.some(v => v.trim())) rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (quoted) throw new Error('El CSV tiene una celda con comillas sin cerrar.');
    row.push(cell); if (row.some(v => v.trim())) rows.push(row);
    if (rows.length < 2) throw new Error('El CSV no contiene registros.');
    const headers = rows.shift().map(v => v.trim());
    return rows.map((values, i) => { if (values.length !== headers.length) throw new Error(`Fila ${i + 2}: columnas distintas del encabezado.`); return Object.fromEntries(headers.map((h, j) => [h, values[j]])); });
  }
  function readConsolidatedCSV(raw, study) {
    const rows = parseCSV(raw);
    const columns = Object.keys(rows[0]);
    const resultColumns = columns.filter(h => /^\[.+\] Resultado$/.test(h));
    if (!columns.includes('ID Auditoría') || !resultColumns.length) throw new Error('Usa el consolidado de ValidaFlow con ID Auditoría y columnas [KPI] Resultado; no una base diaria sin decisiones.');
    return normalizeAudits(rows.map(row => ({ id: row['ID Auditoría'], study: row['Estudio / Canal'] || study,
      country: row['País'], pdv: row['ID PDV'], auditor: row.Auditor,
      region:row['Región'] || row.region, channel:row['Canal'] || row.canal, subchannel:row['Subcanal'] || row.subcanal,
      periodDate: row['Fecha Auditoría'], auditDate: row['Fecha auditoría original'] || null,
      alertUploadedAt:row['Fecha carga alertas'] || row.alertUploadedAt,
      kpis: resultColumns.filter(h => text(row[h])).map(h => {
        const name = h.slice(1, -11);
        return { name, needsReview: true, decision: row[h], reason: row[`[${name}] Tipificación No Aplica`],
          validatedAt:row[`[${name}] Fecha validación`] };
      })
    })));
  }
  function attachContext(audits, raw) {
    const rows = parseCSV(raw), map = new Map();
    const lookup = (row, aliases) => { const key = Object.keys(row).find(k => aliases.includes(norm(k).replace(/[ _]/g, ''))); return key ? text(row[key]) : ''; };
    for (const row of rows) {
      const id = lookup(row, ['idaudito', 'idauditoria', 'iddeaudito']);
      if (!/^\d+$/.test(id)) continue;
      const context = { country: lookup(row, ['pais','country']), auditor: lookup(row, ['auditor','nombreusuario']),
        pdv: lookup(row, ['idpdv','iddepdv']), region:normalizeRegion(lookup(row,['region'])), channel:lookup(row,['canal','channel']),
        subchannel:lookup(row,['subcanal','subchannel']), auditEvent:eventStamp(lookup(row,['fechadelaudito','fechaaudito','auditdate','fechaauditoria'])),
        auditDate: dateKey(lookup(row, ['fechadelaudito','fechaaudito','auditdate','fechaauditoria'])) };
      context.auditDate=context.auditEvent?.day || null;
      const previous = map.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(context)) throw new Error(`Export general ambiguo para ID ${id}; no se elige la primera fila.`);
      map.set(id, context);
    }
    if (!map.size) throw new Error('No se encontraron IDs de auditoría numéricos en el Export general.');
    let matched = 0;
    const enriched = audits.map(a => { const c = map.get(a.id); if (!c) return a; matched++;
      return { ...a, auditor: a.auditor && !/sin identificar/i.test(a.auditor) ? a.auditor : c.auditor,
        pdv: a.pdv || c.pdv, country: a.country !== 'Sin país identificado' ? a.country : normalizeCountry(c.country, a.study),
        region:a.region || c.region, channel:a.channel || c.channel, subchannel:a.subchannel || c.subchannel,
        auditDate:c.auditDate || a.auditDate, auditEvent:c.auditEvent || a.auditEvent };
    });
    return { audits: enriched, matched };
  }
  function totals(alerts) {
    const total = alerts.length, applies = alerts.filter(a => a.decision === 'aplica').length,
      rejects = alerts.filter(a => a.decision === 'no_aplica').length;
    return { total, applies, rejects, pending: total - applies - rejects, coverage: ratio(applies + rejects, total), application: ratio(applies, total), rejection: ratio(rejects, total) };
  }
  function groups(alerts, keys) {
    const map = new Map();
    for (const a of alerts) { const key = JSON.stringify(keys.map(k => a[k])); if (!map.has(key)) map.set(key, []); map.get(key).push(a); }
    return [...map.values()].map(items => ({ ...Object.fromEntries(keys.map(k => [k, items[0][k]])), ...totals(items) }));
  }
  function excludeUndatedPending(audits) {
    // Apply after date enrichment. Keep decisions even on partially reviewed
    // audits; never substitute the upload/jornada date for the original date.
    return audits.flatMap(a => {
      if (dateKey(a.auditDate)) return [a];
      const kpis = a.kpis.filter(k => k.decision !== 'pendiente');
      if (kpis.length === a.kpis.length) return [a];
      return kpis.length ? [{...a,kpis}] : [];
    });
  }
  function compute(audits, filters) {
    const asOf = dateKey(filters.asOf);
    if (!asOf) throw new Error('El corte debe ser una fecha válida.');
    const { from = '', to = asOf, study = 'all', country = 'all', region='all', channel='all', subchannel='all', month = '' } = filters;
    if ((from && !dateKey(from)) || (to && !dateKey(to)) || (from && to && from > to)) throw new Error('El rango de fechas no es válido.');
    const dimension=(value,label)=>value || `Sin ${label}`;
    const selectedRegion=region==='all'?'all':normalizeRegion(region)||'Sin región';
    const scoped = excludeUndatedPending(audits).filter(a => (study === 'all' || a.study === study) && (country === 'all' || a.country === country)
      && (selectedRegion==='all' || dimension(a.region,'región')===selectedRegion) && (channel==='all' || dimension(a.channel,'canal')===channel)
      && (subchannel==='all' || dimension(a.subchannel,'subcanal')===subchannel));
    const undated = scoped.filter(a => !a.periodDate).length;
    const selected = scoped.filter(a => a.periodDate && (!from || a.periodDate >= from) && (!to || a.periodDate <= to) && a.periodDate <= asOf);
    const alerts = selected.flatMap(a => a.kpis.map(k => ({ ...k, id: a.id, module:a.module, study: a.study, country: a.country, geography:a.geography, auditor: a.auditor,
      region:dimension(a.region,'región'),channel:dimension(a.channel,'canal'),subchannel:dimension(a.subchannel,'subcanal'),segment:a.segment, periodDate: a.periodDate, month: a.month })));
    const counts = totals(alerts);
    const backlog = { recent: [], week: [], old: [], missing: [], future: [] };
    for (const a of selected.filter(a => a.kpis.some(k => k.decision === 'pendiente'))) {
      const age = a.auditDate ? Math.round((new Date(asOf) - new Date(a.auditDate)) / DAY) : null;
      const key = age === null ? 'missing' : age < 0 ? 'future' : age < 7 ? 'recent' : age < 15 ? 'week' : 'old';
      backlog[key].push({ ...a, age, pending: a.kpis.filter(k => k.decision === 'pendiente').length });
    }
    const startWeek = shiftDate(weekKey(asOf), -49), auditorMap = new Map();
    let alertsWithoutAuditor = 0;
    for (const a of alerts.filter(a => a.periodDate >= startWeek)) {
      if (!a.auditor || /sin identificar|sin auditor/i.test(a.auditor)) { alertsWithoutAuditor++; continue; }
      const key = JSON.stringify([a.study, a.auditor]);
      if (!auditorMap.has(key)) auditorMap.set(key, { auditor: a.auditor, study: a.study, weeks: new Set(), total: 0 });
      const item = auditorMap.get(key); item.weeks.add(weekKey(a.periodDate)); item.total++;
    }
    const recurrence = [...auditorMap.values()].map(item => ({ ...item, weeks: item.weeks.size })).sort((a,b) => b.total - a.total || a.auditor.localeCompare(b.auditor) || a.study.localeCompare(b.study));
    const reasonCounts = new Map();
    alerts.filter(a => a.decision === 'no_aplica').forEach(a => { const name = a.reason || 'Sin tipificación'; reasonCounts.set(name, (reasonCounts.get(name) || 0) + 1); });
    const reasons = [...reasonCounts].map(([name, count]) => ({ name, count, share: ratio(count, counts.rejects) })).sort((a,b) => b.count - a.count);
    const monthIsComplete = m => { const bounds = monthBounds(m); return !!from && from <= bounds.start && !!to && to >= bounds.end && asOf >= bounds.end; };
    const monthly = groups(alerts, ['month','study','geography']).sort((a,b) => a.month.localeCompare(b.month) || a.study.localeCompare(b.study) || a.geography.localeCompare(b.geography));
    for (const row of monthly) {
      const prev = monthly.find(p => p.month === previousMonth(row.month) && p.study === row.study && p.geography === row.geography);
      row.partial = !monthIsComplete(row.month);
      row.change = prev && !row.partial && !prev.partial && monthIsComplete(prev.month) ? ratio(row.total - prev.total, prev.total) : null;
    }
    const monthlyAlerts = alerts.filter(a => !month || a.month === month);
    const benchmark = groups(monthlyAlerts, ['study','geography']).sort((a,b) => b.total - a.total || a.study.localeCompare(b.study) || a.geography.localeCompare(b.geography));
    const rejectedTypes = groups(monthlyAlerts, ['name']).sort((a,b) => b.total - a.total || a.name.localeCompare(b.name));
    const dimensionKeys=['study','country','region','channel','subchannel'];
    const workload=groups(alerts,dimensionKeys).sort((a,b)=>b.total-a.total || dimensionKeys.map(key=>a[key]).join('|').localeCompare(dimensionKeys.map(key=>b[key]).join('|')));
    const performance=groups(monthlyAlerts,dimensionKeys).sort((a,b)=>b.total-a.total);
    const auditCountsByStudy={};for(const a of selected)auditCountsByStudy[a.study]=(auditCountsByStudy[a.study]||0)+1;
    return { counts, audits: selected.length, auditCountsByStudy, alerts, backlog, recurrence, startWeek, alertsWithoutAuditor, reasons, monthly, benchmark, rejectedTypes,
      workload, performance, timing:timing(selected,asOf), sla:validationSlaStatistics(selected,asOf),
      missingRegions:selected.filter(a=>!a.region).length, missingSubchannels:selected.filter(a=>!a.subchannel).length,
      missingPeriodDates: undated, missingCountries: selected.filter(a => a.country === 'Sin país identificado').length,
      missingPdv: selected.filter(a => !a.pdv).length, monthlyCounts: totals(monthlyAlerts) };
  }
  const api = { dateKey, weekKey, ratio, eventStamp, interval, normalizeStudy, normalizeRegion, isReportAudit, normalizeAudits, parseCSV, readConsolidatedCSV, attachContext, excludeUndatedPending, compute, totals, auditValidationSla,validationSlaExport,validationSlaStatistics,formatSla };
  root.PortalIndicatorMetrics = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
