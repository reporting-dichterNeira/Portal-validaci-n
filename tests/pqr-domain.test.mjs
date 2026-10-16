import {test} from 'node:test';
import assert from 'node:assert/strict';
import {today,reviewError,safeUrl,evidenceEntries,exportRows,csv,exportHeaders} from '../js/pqr-domain.mjs';
import {dashboardView,detailView,loginView} from '../js/pqr-ui.mjs';

test('same-day boundary uses Colombia even when UTC has entered the next day',()=>{
 assert.equal(today(new Date('2026-10-17T04:59:59Z')),'2026-10-16');
 assert.equal(today(new Date('2026-10-17T05:00:00Z')),'2026-10-17');
});
test('completion requires all alerts and an explanation/correct decision for errors',()=>{
 const kpis=[{name:'A'},{name:'B'}];assert.ok(reviewError(kpis,{A:{evaluation:'correct'}},true));
 assert.equal(reviewError(kpis,{A:{evaluation:'correct'}},false),'');
 assert.ok(reviewError(kpis,{A:{evaluation:'incorrect',correct_decision:'aplica',comment:''}},false));
 assert.ok(reviewError(kpis,{A:{evaluation:'not_evaluable',comment:''}},false));
 assert.equal(reviewError(kpis,{A:{evaluation:'incorrect',correct_decision:'aplica',comment:'Evidencia confirma'},B:{evaluation:'correct'}},true),'');
});
test('original answers and PQR decisions remain separate in review and per-alert CSV',()=>{
 const row={id:'one',day:'2026-10-16',external_id:'1',study:'Chile',status:'completed',original_completed_at:'2026-10-16T14:00:00Z',
  started_at:'2026-10-16T16:00:00Z',completed_at:'2026-10-16T16:02:00Z',on_time:true,verdict:'errors',kpis:[{name:'Precio'}],
  original_results:{Precio:{status:'no_aplica',tipificacion:'Otra razón'}},review_results:{Precio:{evaluation:'incorrect',correct_decision:'aplica',comment:'Confirma alerta'}},payload:{}};
 const before=JSON.stringify(row),out=exportRows([row]);assert.equal(out.length,1);assert.equal(out[0][exportHeaders.indexOf('Respuesta original')],'Alerta no válida · No aplica');
 assert.equal(out[0][exportHeaders.indexOf('Respuesta correcta')],'aplica');assert.equal(out[0][exportHeaders.indexOf('Revisada el mismo día')],'Sí');
 const html=detailView(row,'analyst');assert.match(html,/fieldset disabled/);assert.match(html,/RESPUESTA DEL VALIDADOR/);assert.match(html,/Validación con errores/);
 assert.equal(JSON.stringify(row),before);
});
test('analyst view does not include settings, staff creation or reassignment controls',()=>{
 const data={context:{role:'analyst',name:'<script>bad</script>'},today:'2026-10-16',day:'2026-10-16',stats:{selected:1,assigned:1,completed:0},
  analysts:[],reviews:[{id:'1',external_id:'2',day:'2026-10-16',status:'pending',reasons:{},analyst_name:'Ana'}]};
 const html=dashboardView(data,{status:'all',offset:0});assert.doesNotMatch(html,/<script>|pqr-settings|pqr-create-analyst|pqr-create-supervisor|data-reassign|data-delete|data-restore/);assert.match(html,/&lt;script&gt;/);
 data.context.role='supervisor';const supervisor=dashboardView(data,{status:'all',offset:0});assert.match(supervisor,/pqr-settings/);assert.match(supervisor,/pqr-create-analyst/);assert.doesNotMatch(supervisor,/pqr-create-supervisor/);
});
test('supervision separates removed analysts and provides removal and restore actions',()=>{
 const data={context:{role:'supervisor',name:'Supervisión'},stats:{},analysts:[{id:'active',name:'Ana',active:true,available:true},{id:'removed',name:'Luis',active:false,deleted_at:'2026-10-16T12:00:00Z'}],reviews:[]};
 const html=dashboardView(data,{status:'all',offset:0});assert.match(html,/data-delete="active"/);assert.doesNotMatch(html,/data-delete="removed"/);assert.match(html,/Analistas eliminados \(1\)/);assert.match(html,/data-restore="removed"/);
});
test('evidence links reject active content, duplicates collapse, and CSV escapes formulas',()=>{
 assert.equal(safeUrl('javascript:alert(1)'),null);assert.equal(safeUrl('data:text/html,bad'),null);assert.equal(safeUrl('http://unsafe.test'),null);
 assert.equal(evidenceEntries({meta:{foto:'https://example.test/photo'}},{foto:'https://example.test/photo'}).length,1);
 assert.match(csv(['Name'],[['=1+1']]),/"'=1\+1"/);assert.match(loginView('supervisor'),/autocomplete="current-password"/);
});
