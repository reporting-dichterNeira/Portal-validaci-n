// Only collapse a sub-KPI when an explicit TRADICIONAL version exists.
// Unique PORTAFOLIO/TITÁN alerts remain reviewable. Retained keys are stable.
export function preferLindleyTraditional(audit,study=audit?.estudio,module=audit?._module||'blocking'){
 if(study!=='Lindley'||module!=='blocking'||!Array.isArray(audit?.kpis))return audit;
 const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toUpperCase();
 const base=k=>normalize(k.kpiName||k.name);
 const traditional=new Set(audit.kpis.filter(k=>normalize(k.modelo)==='TRADICIONAL').map(base));
 const removed=audit.kpis.filter(k=>normalize(k.modelo)!=='TRADICIONAL'&&traditional.has(base(k)));
 if(!removed.length)return audit;
 const removedSet=new Set(removed),kpis=audit.kpis.filter(k=>!removedSet.has(k));
 const retainedNames=new Set(kpis.map(k=>k.name));
 const results={...(audit.validationResults||{})};
 const archive=removed.map(kpi=>({kpi,...(results[kpi.name]?{validationResult:results[kpi.name]}:{})}));
 for(const kpi of removed)if(!retainedNames.has(kpi.name))delete results[kpi.name];
 return {...audit,kpis,validationResults:results,
  _lindleyModelDuplicates:[...(audit._lindleyModelDuplicates||[]),...archive]};
}
