const {test}=require('node:test');
const assert=require('node:assert/strict');
const M=global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');

const inputs=()=>M.normalizeAudits([
  {id:'1',study:'Moderno',country:'Panamá',periodDate:'2026-10-08',auditor:'Zeta',region:'Sur',kpis:Array.from({length:7},(_,i)=>({name:'Volumen alto',needsReview:true,decision:i?'aplica':'no_aplica'}))},
  {id:'2',study:'Moderno',country:'Colombia',periodDate:'2026-10-01',auditor:'Alfa',region:'Norte',kpis:[{name:'Rechazo alto',needsReview:true,decision:'no_aplica'},{name:'Pendiente',needsReview:true}]},
  {id:'3',study:'Moderno',country:'Colombia',periodDate:'2026-10-08',auditor:'Alfa',region:'Norte',kpis:[{name:'Pendiente',needsReview:true}]}
]);

test('rankings prioritize generated alerts over rejection, pending counts, weeks or alphabet',()=>{
  const r=M.compute(inputs(),{asOf:'2026-10-15'});
  assert.deepEqual(r.rejectedTypes.map(a=>[a.name,a.total]),[['Volumen alto',7],['Pendiente',2],['Rechazo alto',1]]);
  assert.equal(r.benchmark[0].geography,'Panamá');
  assert.equal(r.workload[0].region,'SUR');assert.equal(r.workload[0].pending,0);
  assert.equal(r.recurrence[0].auditor,'Zeta');assert.equal(r.recurrence[0].weeks,1);
  assert.equal(r.recurrence[1].weeks,2);
  const scoped=M.compute(inputs(),{asOf:'2026-10-15',country:'Colombia'});
  assert.deepEqual(scoped.rejectedTypes.map(a=>[a.name,a.total]),[['Pendiente',2],['Rechazo alto',1]]);
  assert.equal(scoped.counts.total,3);
});

test('hierarchical summary ranks study parents and each set of territories by generated volume',()=>{
  const alerts=M.compute(inputs(),{asOf:'2026-10-15'}).alerts;
  alerts.push({...alerts[0],study:'Chile',geography:'Arica'});
  const u={names:['Chile','KO Moderno CAM'],verified:false,rows:[],entry:{loading:false,error:'',data:{}}};
  const groups=U.summaryBenchmarkData({alerts},u);
  assert.deepEqual(groups.map(g=>[g.study,g.total]),[['KO Moderno CAM',10],['Chile',1]]);
  assert.deepEqual(groups[0].territories.map(g=>[g.geography,g.total]),[['Panamá',7],['Colombia',3]]);
});
