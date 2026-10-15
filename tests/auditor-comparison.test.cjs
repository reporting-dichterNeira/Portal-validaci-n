const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const universe=()=>({verified:true,entry:{loading:false,error:'',data:{auditor_totals_ready:true,auditors:[
  {auditor:'campo.uno',databricks_total:20},{auditor:'campo.dos',databricks_total:10},{auditor:'sin.alertas',databricks_total:30}
]}}});
const alert=(id,decision='aplica',extras={})=>({id,decision,study:'Chile',auditor:'campo.uno',module:'blocking',...extras});

test('auditor comparison separates audits from KPIs and deduplicates IDs across modules',()=>{
  const result={alerts:[alert('001'),alert('1','no_aplica',{module:'smart',auditor:' CAMPO.UNO '}),alert('2','pendiente'),alert('3','aplica'),alert('4','aplica',{auditor:'campo.dos'}),alert('5','aplica',{auditor:''})]};
  const data=U.auditorComparisonData(result,universe());
  assert.equal(data.unidentified,1);
  assert.deepEqual(data.rows.map(r=>[r.auditor,r.audits,r.alertedAudits,r.total,r.applies,r.alertedShare]),[
    ['campo.uno',20,3,4,2,.15],['campo.dos',10,1,1,1,.1],['sin.alertas',30,0,0,0,0]
  ]);
  const html=U.auditorComparison(result,universe());
  assert.match(html,/Auditorías con alerta/);assert.match(html,/KPIs aplican/);assert.match(html,/15%/);
  assert.match(html,/data-chart-table-export/);assert.doesNotMatch(html,/data-metric-chart|metric-chart-details|Semanas con alertas/);
});

test('comparison uses the full filtered period and keeps a study in the audit identity',()=>{
  const result={alerts:[alert('1','aplica',{periodDate:'2026-01-01'}),alert('1','aplica',{study:'Lindley',periodDate:'2026-10-01'})]};
  const first=U.auditorComparisonData(result,universe()).rows[0];
  assert.equal(first.total,2);assert.equal(first.alertedAudits,2);assert.equal(first.alertedShare,.1);
  const scoped=U.auditorComparisonData({alerts:result.alerts.slice(1)},universe()).rows[0];
  assert.equal(scoped.total,1);assert.equal(scoped.alertedAudits,1);
});

test('unknown, loading, failed and zero denominators never become a false 100 percent',()=>{
  for(const mutate of [u=>u.entry.loading=true,u=>u.entry.error='Fallo',u=>u.verified=false,u=>u.entry.data.auditor_totals_ready=false,u=>u.entry.data.auditors=[]]){
    const u=universe();mutate(u);const r=U.auditorComparisonData({alerts:[alert('1')]},u).rows[0];
    assert.equal(r.audits,null);assert.equal(r.alertedShare,null);
  }
  const u=universe();u.entry.data.auditors[0].databricks_total=0;
  assert.equal(U.auditorComparisonData({alerts:[alert('1')]},u).rows[0].alertedShare,null);
});

test('equal alert volumes rank by KPIs applying, then by auditor name; names are escaped',()=>{
  const result={alerts:[alert('1','no_aplica'),alert('2','aplica',{auditor:'campo.dos'}),alert('3','aplica',{auditor:'<auditor>'})]};
  const data=U.auditorComparisonData(result,universe());
  assert.deepEqual(data.rows.slice(0,3).map(r=>r.auditor),['<auditor>','campo.dos','campo.uno']);
  assert.match(U.auditorComparison(result,universe()),/&lt;auditor&gt;/);
});
