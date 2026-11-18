const {test}=require('node:test');
const assert=require('node:assert/strict');
global.PortalIndicatorMetrics=require('../js/indicator-metrics.js');
const U=require('../js/indicator-dashboard.js');
const scope=()=>({names:['KO Moderno CAM'],verified:true,entry:{loading:false,error:'',data:{territory_totals_ready:true,territories:[
  {study_name:'KO Moderno CAM',geography:'Colombia',databricks_total:100,verified:true},
  {study_name:'KO Moderno CAM',geography:'Costa Rica',databricks_total:200,verified:true}
]}},rows:[{study_name:'KO Moderno CAM',databricks_total:300,verified:true}]});
const alert=(id,module='blocking',geography='Colombia',decision='aplica')=>({id,module,geography,study:'KO Moderno CAM',decision});
test('summary counts unique alerted audits across modules and uses each territory base',()=>{
  const result={alerts:[alert('001'),alert('1','smart'),alert('2','blocking','Costa Rica','no_aplica')]};
  const [group]=U.summaryBenchmarkData(result,scope());
  assert.equal(group.audits,2);assert.equal(group.total,3);assert.equal(group.lifted,300);assert.equal(group.alertedShare,2/300);
  assert.equal(group.territories[0].alertedShare,.01);assert.equal(group.territories[1].alertedShare,.005);
  const html=U.summaryBenchmark(result,scope(),{});
  assert.match(html,/% de auditorías alertadas/);assert.match(html,/Total de auditorías/);assert.match(html,/aria-expanded="false"/);
  assert.equal(group.editedAudits,1);assert.equal(group.territories[0].editedAudits,1);assert.match(html,/Auditorías editadas/);
});

test('valid and invalid shares use decided alerts and omit pending',()=>{
 const html=U.decisionDonut({total:6854,applies:1293,rejects:3847,pending:1714});
 assert.match(html,/25,2% de revisadas/);assert.match(html,/74,8% de revisadas/);assert.doesNotMatch(html,/Pendientes/);assert.match(html,/5\.140/);
 const pending=U.decisionDonut({total:2,applies:0,rejects:0,pending:2});assert.doesNotMatch(pending,/NaN|Infinity/);assert.match(pending,/background:#e1e6ed/);
});
test('summary never substitutes the study base for a missing territory or failed query',()=>{
  const u=scope(),result={alerts:[alert('1')]};u.entry.data.territories=[];
  assert.equal(U.summaryBenchmarkData(result,u)[0].territories[0].lifted,null);
  u.entry.error='unavailable';assert.equal(U.summaryBenchmarkData(result,u)[0].lifted,null);
  u.entry.error='';u.rows[0].databricks_total=0;assert.equal(U.summaryBenchmarkData(result,u)[0].alertedShare,null);
});
test('summary respects the already filtered module and waits for complete module histories',()=>{
  const result={alerts:[alert('1','smart'),alert('2','smart','Colombia','no_aplica')]};
  const [group]=U.summaryBenchmarkData(result,scope());assert.equal(group.audits,2);assert.equal(group.applies,1);assert.equal(group.rejects,1);
  assert.match(U.summaryBenchmark(result,scope(),{backend:{configured:true},auditHistoryByModule:{blocking:[]}}),/Consultando el histórico/);
  assert.match(U.summaryBenchmark(result,scope(),{backend:{configured:true},auditHistoryErrors:{smart:'failed'}}),/No se pudo consultar/);
});

test('mixed historical sources still use the explicitly counted Databricks denominator',()=>{ const u=scope();u.rows[0].verified=false;u.entry.data.territories[0].verified=false;const [group]=U.summaryBenchmarkData({alerts:[alert('1')]},u);assert.equal(group.lifted,300);assert.equal(group.territories[0].lifted,100); });
