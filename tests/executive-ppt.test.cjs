const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/executive-ppt.js'),'utf8').replace(/^export /gm,'');
function harness(window={}) {
 const scripts=[];
 const context=vm.createContext({window,document:{createElement:()=>({remove(){}}),head:{appendChild:s=>scripts.push(s)}},setTimeout,clearTimeout});
 vm.runInContext(source,context);
 return {context,scripts};
}
class Engine {
 constructor(){this.slides=[];}
 addSlide(){const slide={texts:[],tables:[],addText(t,o){this.texts.push([t,o]);},addTable(r,o){this.tables.push([r,o]);},addNotes(n){this.notes=n;}};this.slides.push(slide);return slide;}
}
const fixture=()=>({scope:'KO Moderno CAM',module:'Alertas Bloqueantes',date:'10/09/2026',audits:'4495',discarded:'11324',precision:'11%',averageTime:'655s',universe:'193285',universeRows:[['Sin alerta','179983','93.1%'],['Aplica','1353','0.7%'],['No aplica','11324','5.9%'],['Pendientes','625','0.3%']],benchmark:[['KO Moderno CAM','120','228','70','158','31%','90%']],topKpis:Array.from({length:9},(_,i)=>[String(i+1),'KPI '+i,'10','30%']),reasons:[]});
test('editable report preserves selected data, pagination, labels and input',()=>{
 const {context}=harness(),data=fixture(),before=JSON.stringify(data);
 const ppt=context.buildExecutivePowerPoint(Engine,data);
 assert.equal(ppt.layout,'LAYOUT_WIDE');assert.equal(JSON.stringify(data),before);
 const text=JSON.stringify(ppt.slides);
 for(const value of ['4495','11324','655s','193285','KO Moderno CAM','Alertas Bloqueantes','Tiempo promedio por auditoría','no requieren edición'])assert.ok(text.includes(value),value);
 const rankings=ppt.slides.flatMap(s=>s.tables.flatMap(([r])=>r.slice(1))).filter(r=>/^KPI /.test(r[1]?.text));
 assert.equal(rankings.length,9);
 for(const slide of ppt.slides){
  assert.ok(slide.notes.includes(data.scope));
  assert.ok(slide.texts.some(([t])=>t.includes(data.module)));
  for(const [rows,options] of slide.tables){assert.ok(rows.length<=5);assert.equal(options.fontSize,17);assert.equal(options.autoPage,false);assert.ok(options.rowH.reduce((a,b)=>a+b,0)<=4.5);}
 }
});
test('empty filters produce a valid report with no invented rows',()=>{
 const data=fixture();data.benchmark=[];data.topKpis=[];data.universeRows=[];
 const ppt=harness().context.buildExecutivePowerPoint(Engine,data);
 assert.ok(JSON.stringify(ppt.slides).includes('Sin registros para los filtros seleccionados'));
});
test('engine is lazy, single-flight, cached and retryable after network failure',async()=>{
 const {context,scripts}=harness();assert.equal(scripts.length,0);
 const first=context.loadPowerPointEngine(),same=context.loadPowerPointEngine();
 assert.equal(first,same);assert.equal(scripts.length,1);
 const rejection=assert.rejects(first,/No se pudo cargar PowerPoint/);scripts[0].onerror();await rejection;
 const retry=context.loadPowerPointEngine();assert.equal(scripts.length,2);
 context.window.PptxGenJS=Engine;scripts[1].onload();assert.equal(await retry,Engine);
 assert.equal(await context.loadPowerPointEngine(),Engine);assert.equal(scripts.length,2);
});
