const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const scope=()=>({names:['KO Moderno CAM'],verified:true,rows:[{study_name:'KO Moderno CAM',databricks_total:100}],entry:{loading:false,error:'',data:{territory_totals_ready:true,territories:[
  {study_name:'KO Moderno CAM',geography:'Panamá',databricks_total:80},
  {study_name:'KO Moderno CAM',geography:'Costa Rica',databricks_total:20}
]}}});
const alert=(id,decision='aplica',extras={})=>({id,decision,study:'KO Moderno CAM',geography:'Panamá',auditor:'campo.uno',module:'blocking',...extras});

test('territory table uses the same comparison indicators as auditors, including undecided alerts in the average',()=>{
  const result={alerts:[alert('001'),alert('1','no_aplica',{module:'smart'}),alert('2','pendiente'),alert('3')]};
  const rows=U.territoryComparisonData(result,scope());
  assert.equal(rows[0].audits,80);assert.equal(rows[0].alertedAudits,3);assert.equal(rows[0].total,4);
  assert.equal(rows[0].alertedShare,3/80);assert.equal(rows[0].meanAlerts,4/3);assert.equal(rows[0].validShare,2/3);
  assert.equal(rows[1].total,0);assert.equal(rows[1].alertedShare,0);assert.equal(rows[1].meanAlerts,null);assert.equal(rows[1].validShare,null);
  const html=U.territoryComparison(result,scope(),'Mes: 2026-10');
  assert.match(html,/Alertas válidas/);assert.match(html,/Promedio de alertas por auditoría alertada/);assert.match(html,/1,33/);assert.match(html,/66,7%/);
  assert.match(html,/data-chart-table-export/);assert.doesNotMatch(html,/data-metric-chart|metric-chart-details|NaN|Infinity/);
});

test('territory totals never use the study denominator for an unknown territory or unavailable source',()=>{
  for(const change of [u=>u.entry.loading=true,u=>u.entry.error='Fallo',u=>u.verified=false,u=>u.entry.data.territory_totals_ready=false,u=>u.entry.data.territories=[]]){
    const u=scope();change(u);const row=U.territoryComparisonData({alerts:[alert('1')]},u)[0];
    assert.equal(row.audits,null);assert.equal(row.alertedShare,null);assert.equal(row.meanAlerts,1);assert.equal(row.validShare,1);
  }
});

test('all pending decisions leave validity without a base; filtered and empty scopes stay honest',()=>{
  const pending=U.territoryComparisonData({alerts:[alert('1','pendiente'),alert('1','pendiente',{module:'smart'})]},scope())[0];
  assert.equal(pending.meanAlerts,2);assert.equal(pending.validShare,null);
  const u=scope();u.entry.data.territories=[];
  assert.deepEqual(U.territoryComparisonData({alerts:[]},u),[]);
  assert.match(U.territoryComparison({alerts:[]},u,''),/Sin registros para este alcance/);
});

test('rankings compare alert volume first and valid alerts second while keeping study identities separate',()=>{
  const result={alerts:[alert('1'),alert('1','no_aplica',{study:'KO Tradicional CAM'}),alert('1','aplica',{geography:'Costa Rica'}),alert('2','aplica',{geography:'Costa Rica'})]};
  const rows=U.territoryComparisonData(result,scope());
  assert.equal(rows[0].geography,'Costa Rica');assert.equal(rows[0].total,2);assert.equal(rows[0].meanAlerts,1);
  assert.equal(rows[1].study,'KO Moderno CAM');assert.equal(rows[2].study,'KO Tradicional CAM');
});
