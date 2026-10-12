(function(root){
 'use strict';
 const U=root.PortalIndicators;
 const key=app=>[app.currentProfile?.id,app.currentScope?.study?.id,app.currentScope?.country?.id,app.currentModule].join('|');
 const pendingKpis=a=>(a.payload?.kpis || []).filter(k=>(k.needsReview || k.alertaStatus==='SE ALERTA') && !['aplica','no_aplica'].includes(a.validation_results?.[k.name]?.status));
 const groupLoads=rows=>{const groups=new Map();for(const a of rows){const k=JSON.stringify([a.operation_date,a.source_filename,a.load_batch_id||a.batch_id]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a);}return [...groups.values()];};
 function render(app,{force=false}={}) {
  const el=document.getElementById('supervisor-pending-management');if(!el)return;
  if(app.currentRole!=='supervisor'||!app.currentScope||!app.backend?.configured){el.innerHTML='';return;}
  const scopeKey=key(app);let s=app.pendingWorkspace;
  if(!s||s.key!==scopeKey)s=app.pendingWorkspace={key:scopeKey,data:null,loading:false,loadedAt:0,error:''};
  if(!s.loading && (force || !s.loadedAt || Date.now()-s.loadedAt>60000)) {
   s.loading=true;s.error='';
   app.backend.loadPendingManagement(app.currentModule).then(data=>{if(key(app)!==scopeKey)return;s.data=data;s.loadedAt=Date.now();})
    .catch(e=>{if(key(app)===scopeKey){s.error=e.message;s.loadedAt=Date.now();}})
    .finally(()=>{s.loading=false;if(key(app)===scopeKey)render(app);});
  }
  if(!s.data){el.innerHTML=U.panel('📋 Seguimiento de pendientes',s.error||'Consultando las cargas de este estudio y módulo…','<button type="button" class="btn btn-outline" data-refresh-pending>Actualizar pendientes</button>');el.querySelector('button').onclick=()=>render(app,{force:true});return;}
  const rows=s.data.audits||[];
  const yesterday=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Managua',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86400000));
  const entries=groupLoads(rows);const page=Math.min(s.page||0,Math.max(0,Math.ceil(entries.length/8)-1));s.page=page;
  el.innerHTML=U.panel('📋 Seguimiento de pendientes',rows.length+' auditorías sin completar en '+entries.length+' cargas · '+rows.filter(a=>a.operation_date<=yesterday).length+' de jornadas anteriores. Incluye hoy y no depende del filtro de Visualizaciones.',
   '<p><strong>'+U.esc(app.currentScope?.study?.name)+' · '+(app.currentModule==='blocking'?'🚫 Bloqueantes':'⚡ Smart')+'</strong></p><p>1. Elige el archivo → 2. Revisa las pendientes → 3. Reasigna o elimina. Bases repetidas o reemplazadas no suman. Las completadas se conservan.</p>'+(s.error?'<p role="alert">'+U.esc(s.error)+'</p>':'')+(!rows.length?'<p>✅ No hay auditorías pendientes en este estudio y módulo.</p>':'')+U.table(['Carga / archivo Excel','Jornada original','⏳ Pendientes','🔄 Reasignadas','Qué desea hacer'],entries.slice(page*8,page*8+8).map((list,i)=>U.row([U.esc(list[0].source_filename),U.esc(list[0].operation_date),'<strong>'+list.length+'</strong>',list.filter(a=>a.pending_resolution==='reassigned').length,'<button class="btn btn-outline btn-sm" data-pending-download="'+(page*8+i)+'">⬇ CSV</button> <button class="btn btn-primary btn-sm" data-pending-manage="'+(page*8+i)+'">🔍 Ver detalle / reasignar</button> <button class="btn btn-danger btn-sm" data-pending-remove="'+(page*8+i)+'">🗑 Eliminar pendientes de carga</button>'])))+
   '<div class="indicator-controls"><button class="btn btn-outline btn-sm" data-pending-page="'+(page-1)+'" '+(page===0?'disabled':'')+'>Anterior</button><span>Archivos '+(entries.length?page*8+1:0)+'–'+Math.min(entries.length,(page+1)*8)+' de '+entries.length+'</span><button class="btn btn-outline btn-sm" data-pending-page="'+(page+1)+'" '+((page+1)*8>=entries.length?'disabled':'')+'>Siguiente</button><button class="btn btn-outline btn-sm" data-refresh-pending '+(s.loading?'disabled':'')+'>Actualizar pendientes</button></div><p>Retirar conserva un registro recuperable con sus decisiones parciales. Reasignar conserva ID y jornada, sin duplicar la carga.</p>')+
   U.panel('Historial de decisiones','Últimas decisiones de este alcance. Las validadas nunca se eliminan desde este apartado.',U.table(['Fecha','ID interno','Acción','Motivo','Destino'],(s.data.history||[]).slice(0,20).map(h=>U.row([U.esc(h.decided_at),h.audit_id,U.esc(h.action==='remove'?'Retirada':h.action==='assign'?'Reasignada':'Versión reemplazada'),U.esc(h.reason),U.esc(h.target_validator_id || '—')]))));
  el.querySelector('[data-refresh-pending]').onclick=()=>render(app,{force:true});
  el.querySelectorAll('[data-pending-page]').forEach(b=>b.onclick=()=>{s.page=Number(b.dataset.pendingPage);render(app);});
  el.querySelectorAll('[data-pending-download]').forEach(b=>b.onclick=()=>download(entries[Number(b.dataset.pendingDownload)]));
  el.querySelectorAll('[data-pending-manage]').forEach(b=>b.onclick=()=>manage(app,entries[Number(b.dataset.pendingManage)],scopeKey));
  el.querySelectorAll('[data-pending-remove]').forEach(b=>b.onclick=()=>manage(app,entries[Number(b.dataset.pendingRemove)],scopeKey,'remove'));
 }
 function download(audits){U.download(['ID auditoría','Archivo','Jornada original','País','Validador','Sub-KPI pendiente'],audits.flatMap(a=>{const ks=pendingKpis(a);return (ks.length?ks:[{name:'Sin KPI pendiente identificado'}]).map(k=>[a.external_id,a.source_filename,a.operation_date,a.payload?.pais,a.validator_name,k.name]);}),'Auditorias-pendientes.csv');}
 function manage(app,audits,scopeKey,initialAction=null) {
  document.getElementById('pending-decision-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='pending-decision-dialog';dialog.className='pending-dialog';
  const lot=[...audits].sort((a,b)=>Number(a.pending_resolution==='reassigned')-Number(b.pending_resolution==='reassigned')).slice(0,2000);
  const selection=new Set((initialAction?audits:lot).map(a=>a.id));let action=null,busy=false,detailPage=0;
  dialog.innerHTML='<h2>'+audits.length+' auditorías pendientes: ¿qué desea hacer?</h2><p>'+U.esc(audits[0]?.source_filename)+' · Jornada '+U.esc(audits[0]?.operation_date)+'</p><p>Selecciona toda la carga o casos individuales. Las completadas no aparecen y nunca se eliminan aquí.</p><label><input type="checkbox" data-all checked> Seleccionar todas ('+audits.length+')</label><div data-detail></div><div class="indicator-controls"><button class="btn btn-outline btn-sm" data-prev>Anterior</button><span data-detail-page></span><button class="btn btn-outline btn-sm" data-next>Siguiente</button></div>'+
   '<p>Las cargas grandes se procesan en lotes de hasta 2.000, sin perder la selección completa.</p><button class="btn btn-outline btn-sm" data-lot>Seleccionar lote de hasta 2.000</button><p data-count></p><div class="indicator-controls"><button class="btn btn-outline" data-download>Descargar seleccionadas</button><button class="btn btn-primary" data-action="assign">Reasignar a un validador</button><button class="btn btn-danger" data-action="remove">Eliminar del operativo</button></div><div data-confirmation></div><p data-error role="alert"></p><button class="btn btn-outline" data-close>Cerrar</button>';
  document.body.append(dialog);dialog.showModal();
  const renderDetail=()=>{dialog.querySelector('[data-detail]').innerHTML=U.table(['Seleccionar','ID auditoría','País','Responsable','Estado','Alertas pendientes'],audits.slice(detailPage*100,detailPage*100+100).map(a=>U.row(['<input type="checkbox" data-id="'+a.id+'" '+(selection.has(a.id)?'checked':'')+' aria-label="Auditoría '+U.esc(a.external_id)+'">',U.esc(a.external_id),U.esc(a.payload?.pais||'Sin país'),U.esc(a.validator_name),a.status==='en_progreso'?'En progreso':'Pendiente',pendingKpis(a).length])));dialog.querySelector('[data-detail-page]').textContent='Página '+(detailPage+1)+' de '+Math.ceil(audits.length/100);dialog.querySelector('[data-prev]').disabled=detailPage===0;dialog.querySelector('[data-next]').disabled=(detailPage+1)*100>=audits.length;dialog.querySelectorAll('[data-id]').forEach(c=>c.onchange=()=>{c.checked?selection.add(Number(c.dataset.id)):selection.delete(Number(c.dataset.id));update();});};
  const update=()=>{dialog.querySelector('[data-count]').textContent=selection.size+' seleccionadas';dialog.querySelector('[data-confirmation]').innerHTML='';action=null;
   const all=dialog.querySelector('[data-all]');all.checked=selection.size===audits.length;all.indeterminate=selection.size>0&&selection.size<audits.length;
   dialog.querySelectorAll('[data-id]').forEach(c=>c.checked=selection.has(Number(c.dataset.id)));};
  dialog.querySelector('[data-lot]').onclick=()=>{selection.clear();lot.forEach(a=>selection.add(a.id));update();};
  renderDetail();dialog.querySelector('[data-prev]').onclick=()=>{detailPage--;renderDetail();};dialog.querySelector('[data-next]').onclick=()=>{detailPage++;renderDetail();};
  update();dialog.querySelector('[data-all]').onchange=e=>{selection.clear();if(e.target.checked)audits.forEach(a=>selection.add(a.id));dialog.querySelectorAll('[data-id]').forEach(c=>c.checked=e.target.checked);update();};
  dialog.querySelectorAll('[data-id]').forEach(c=>c.onchange=()=>{c.checked?selection.add(Number(c.dataset.id)):selection.delete(Number(c.dataset.id));update();});
  dialog.querySelector('[data-download]').onclick=()=>download(audits.filter(a=>selection.has(a.id)));
  dialog.querySelector('[data-close]').onclick=()=>{if(!busy){dialog.close();dialog.remove();}};
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{
   if(!selection.size)return;action=b.dataset.action;
   const selected=audits.filter(a=>selection.has(a.id));
   const countryKey=v=>normalizeCountry(app.normalizeBenchmarkCountry?.(v)||v);
   const restrictCountry=app.currentModule==='smart'&&['Tradicional','Moderno'].includes(app.currentScope?.study?.name);
   const validators=app.getValidatorsForCurrentProject().filter(v=>v.isActive!==false && (!restrictCountry||!(v.smartCountries||[]).length || selected.every(a=>(v.smartCountries||[]).some(c=>countryKey(c)===countryKey(a.payload?.pais)))));
   dialog.querySelector('[data-confirmation]').innerHTML='<h3>'+selection.size+' auditorías: '+(action==='assign'?'reasignar':'retirar del operativo')+'</h3>'+(action==='assign'?'<label>Destino<select class="form-control" data-target><option value="">Selecciona un validador compatible</option>'+validators.map(v=>'<option value="'+U.esc(v.id)+'">'+U.esc(v.name)+'</option>').join('')+'</select></label>':'<p>Se retirarán de pendientes y asignaciones, sin borrar el registro de respaldo.</p>')+'<label>Motivo obligatorio<textarea class="form-control" rows="2" data-reason maxlength="1000"></textarea></label><label><input type="checkbox" data-confirm> Confirmo aplicar esta decisión a las '+selection.size+' seleccionadas</label><button class="btn btn-primary" data-apply>Confirmar decisión</button>';
   dialog.querySelector('[data-apply]').onclick=async e=>{
    const error=dialog.querySelector('[data-error]');error.textContent='';
    const reason=dialog.querySelector('[data-reason]').value.trim(),target=dialog.querySelector('[data-target]')?.value||null;
    if(busy||!dialog.querySelector('[data-confirm]').checked||reason.length<3||(action==='assign'&&!target)){error.textContent='Selecciona destino cuando corresponda, indica motivo y marca la confirmación.';return;}
    if(key(app)!==scopeKey){error.textContent='Cambió el estudio o módulo. Cierra y vuelve a consultar las pendientes.';return;}
    busy=true;dialog.querySelectorAll('button,input,select,textarea').forEach(x=>x.disabled=true);
    try {
     const ids=[...selection];for(let i=0;i<ids.length;i+=2000){await app.backend.resolvePreviousPending(ids.slice(i,i+2000),action,reason,target);ids.slice(i,i+2000).forEach(id=>selection.delete(id));}
     dialog.close();dialog.remove();app.pendingWorkspace=null;app.auditHistoryByModule[app.currentModule]=null;
     let data;
     try {data=await app.backend.loadState();}
     catch(refreshError){app.renderAdminView();app.showToast('La decisión quedó guardada. Actualiza la página para recargar las asignaciones.','warning');return;}
     app.validators=data.validators;app.smartAudits=data.smartAudits;app.blockingAudits=data.blockingAudits;
     app.audits=app.currentModule==='blocking'?app.blockingAudits:app.smartAudits;
     app.renderAdminView();app.showToast('Decisión guardada. Se actualizaron pendientes y asignaciones.','success');
    } catch(err){app.pendingWorkspace=null;app.auditHistoryByModule[app.currentModule]=null;error.textContent='Quedan '+selection.size+' seleccionadas sin procesar. '+err.message;dialog.querySelectorAll('button,input,select,textarea').forEach(x=>x.disabled=false);renderDetail();}
    finally{busy=false;}
   };
  });
  if(initialAction)dialog.querySelector('[data-action="'+initialAction+'"]').click();
 }
 const normalizeCountry=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
 root.PortalPending={render,pendingKpis,groupLoads};
})(typeof globalThis!=='undefined'?globalThis:this);
