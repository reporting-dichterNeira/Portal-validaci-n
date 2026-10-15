const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const M=global.PortalIndicatorMetrics;
const U=require('../js/indicator-dashboard.js');
const scope=()=>({verified:true,entry:{loading:false,error:'',data:{channel_segment_totals_ready:true,channel_segments:[
  {study_name:'Chile',channel:' Grocery  Shopping ',segmento:' a ',databricks_total:80},
  {study_name:'Chile',channel:'GROCERY SHOPPING',segmento:'B',databricks_total:20}
]}}});
const alert=(id,decision='aplica',extra={})=>({id,decision,study:'Chile',channel:'GROCERY SHOPPING',segment:'A',region:'NORTE',module:'blocking',...extra});

test('channel and segment merge across regions, deduplicate module IDs, and use their own denominator',()=>{
  const result={alerts:[alert('001'),alert('1','no_aplica',{module:'smart',region:'SUR',channel:'grocery shopping',segment:' a '}),alert('2','pendiente'),alert('3')]};
  const rows=U.channelSegmentComparisonData(result,scope());
  assert.equal(rows.length,2);assert.equal(rows[0].audits,80);assert.equal(rows[0].alertedAudits,3);assert.equal(rows[0].total,4);
  assert.equal(rows[0].alertedShare,3/80);assert.equal(rows[0].meanAlerts,4/3);assert.equal(rows[0].validShare,2/3);
  assert.equal(rows[1].total,0);assert.equal(rows[1].alertedShare,0);assert.equal(rows[1].meanAlerts,null);assert.equal(rows[1].validShare,null);
  const html=U.channelSegmentComparison(result,scope(),'Mes: 2026-10');
  for(const label of ['Canal','Segmento','Auditorías con alerta','KPIs con alerta','KPIs aplican','Promedio de alertas por auditoría alertada'])assert.ok(html.includes(label));
  assert.match(html,/1,33/);assert.match(html,/66,7%/);assert.match(html,/data-chart-table-export/);
  assert.doesNotMatch(html,/data-metric-chart|metric-chart-details|NaN|Infinity/);
});

test('unavailable or unmatched source never substitutes a broader total',()=>{
  for(const change of [u=>u.entry.loading=true,u=>u.entry.error='Fallo',u=>u.verified=false,u=>u.entry.data.channel_segment_totals_ready=false,u=>u.entry.data.channel_segments=[]]){
    const u=scope();change(u);const row=U.channelSegmentComparisonData({alerts:[alert('1')]},u)[0];
    assert.equal(row.audits,null);assert.equal(row.alertedShare,null);assert.equal(row.meanAlerts,1);assert.equal(row.validShare,1);
  }
});

test('missing segments are explicit, numeric segments survive, and studies stay separate',()=>{
  const rows=U.channelSegmentComparisonData({alerts:[alert('1','pendiente',{segment:''}),alert('2','aplica',{segment:'1'}),alert('2','aplica',{study:'Lindley',segment:'1'})]},scope());
  assert.ok(rows.some(r=>r.segment==='Sin segmento identificado'&&r.validShare===null));
  assert.equal(rows.filter(r=>r.segment==='1').length,2);
  const u=scope();u.entry.data.channel_segments=[];
  assert.deepEqual(U.channelSegmentComparisonData({alerts:[]},u),[]);
});

test('segmento travels from Databricks context through calculations and CSV without using subchannel',()=>{
  const raw={id:'1',_module:'smart',estudio:'Chile',pais:'Chile',fecha:'2026-10-10',subcanal:'Tienda',kpis:[{name:'K',needsReview:true}],validationResults:{K:{status:'aplica'}}};
  const context=[{audit_external_id:'1',study:'ko_trad_ch',segmento:'Premium'}];
  const inputs=U.adapt([raw],context,a=>a.pais,'all');
  assert.equal(inputs[0].segment,'Premium');assert.equal(U.adapt([raw],[],null,'all')[0].segment,'');
  assert.equal(M.compute(inputs,{asOf:'2026-10-15'}).alerts[0].segment,'Premium');
  const out=U.alertExport([raw],context,a=>a.pais,'all');assert.equal(out.rows[0][out.headers.indexOf('Segmento')],'Premium');
});

test('source and receiver preserve the literal segmento column and filtered aggregate remains opt-in',()=>{
  const read=path=>fs.readFileSync(require('node:path').join(__dirname,'..',path),'utf8');
  assert.match(read('databricks/validaflow_general_export.py'),/canal, region, segmento/);
  assert.match(read('databricks/validaflow_general_export.py'),/"segmento": clean\(row.get\("segmento"\)\)/);
  assert.match(read('supabase/functions/sync-databricks-export/index.ts'),/'subchannel', 'segmento', 'auditor'/);
  const sql=read('supabase/sql/channel-segment-comparison.sql');
  assert.match(sql,/from selected where coalesce\(p_filters->>'include_channel_segments'/);
  assert.match(sql,/group by study_name,2,3/);assert.match(sql,/enable row level security/);
});
