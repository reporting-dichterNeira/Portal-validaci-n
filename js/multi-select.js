(function(root){
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list=value=>Array.isArray(value)?value:value&&value!=='all'&&value!=='ALL'?[value]:[];
  function render(name,label,value,choices,attribute=''){
    const selected=list(value).filter(v=>v!=='all'&&v!=='ALL');
    const rows=choices.filter(o=>o.value!=='all'&&o.value!=='__multiple__');
    return '<div class="portal-multi"><span>'+escape(label)+'</span><details '+attribute+' data-multi-name="'+escape(name)+'"><summary>'+escape(selected.length?rows.filter(o=>selected.includes(o.value)).map(o=>o.label).join(', ')||selected.join(', '):'Todos')+'</summary><div class="portal-multi-options"><label><input type="checkbox" data-multi-all '+(!selected.length?'checked':'')+'>Todos</label>'+rows.map(o=>'<label><input type="checkbox" data-multi-option value="'+escape(o.value)+'" '+(selected.includes(o.value)?'checked':'')+'>'+escape(o.label)+'</label>').join('')+'<button type="button" data-multi-apply>Aplicar selección</button></div><div data-multi-values>'+ (selected.length?selected:['all']).map(v=>'<input type="hidden" name="'+escape(name)+'" value="'+escape(v)+'">').join('')+'</div></details></div>';
  }
  if(typeof document!=='undefined')document.addEventListener('click',event=>{
    const box=event.target.closest('[data-multi-name]');if(!box)return;
    if(event.target.matches('[data-multi-all]'))box.querySelectorAll('[data-multi-option]').forEach(el=>el.checked=false);
    if(event.target.matches('[data-multi-option]'))box.querySelector('[data-multi-all]').checked=![...box.querySelectorAll('[data-multi-option]')].some(el=>el.checked);
    if(!event.target.closest('[data-multi-apply]'))return;
    const values=[...box.querySelectorAll('[data-multi-option]:checked')].map(el=>el.value);
    box.value=values.length?values:'all';
    box.querySelector('[data-multi-values]').innerHTML=(values.length?values:['all']).map(v=>'<input type="hidden" name="'+escape(box.dataset.multiName)+'" value="'+escape(v)+'">').join('');
    box.querySelector('summary').textContent=values.length?[...box.querySelectorAll('[data-multi-option]:checked')].map(el=>el.parentElement.textContent).join(', '):'Todos';
    box.open=false;box.dispatchEvent(new Event('change'));
  });
  root.PortalMultiSelect={render,list};
})(globalThis);
