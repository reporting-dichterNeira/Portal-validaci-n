const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function fixture(role='commercial'){
 const elements=new Map(),calls=[];
 function element(id,dataset={}){
  const classes=new Set();const el={id,dataset,textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){on??=!classes.has(c);on?classes.add(c):classes.delete(c);}}};elements.set(id,el);return el;
 }
 const tabs=['overview','editions','score-changes','metrics','committee'].map(tab=>element('tab-'+tab,{visualizationTab:tab}));
 const panes=['overview','editions','score-changes','metrics','committee'].map(tab=>element('visualization-pane-'+tab));
 const notes=element('notes');
 for(const id of ['btn-subtab-daily','btn-subtab-metrics','metrics-view-daily','metrics-view-operational','metrics-view-executive','modal-daily-detail','modal-blocking-kpis','visualization-user-name','visualization-user-role','visualization-portal-subtitle','visualization-powerbi-link','visualization-module-switcher','visualization-date-filter','reports-view-title','reports-view-subtitle','view-landing','public-validator-view','view-supervisor-hub','private-supervisor-view','view-administrator','view-visualizations','supervisor-nav-tabs'])element(id);
 elements.get('modal-daily-detail').classList.add('hidden');elements.get('modal-blocking-kpis').classList.add('hidden');
 const document={getElementById:id=>elements.get(id)||null,querySelectorAll:selector=>selector==='.visualization-tab'?tabs:selector==='.visualization-pane'?panes:selector==='.btn-open-blocking-kpis'?[notes]:[]};
 const context=vm.createContext({document,console,window:{},getStudyDisplayName:v=>v});
 let source=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
 source=source.slice(0,source.indexOf('// Inicializar la aplicación inmediatamente')).replace(/^import .*;\r?\n/gm,'');
 vm.runInContext(source+'\nthis.App=ValidaFlowApp;',context);
 const app=Object.assign(Object.create(context.App.prototype),{currentRole:role,currentProfile:{id:'fixture',display_name:'Prueba'},currentView:'visualizations',currentModule:'blocking',visualizationTab:'editions',reportsSubtab:'daily',
  mountVisualizationContent(){},updateVisualizationModuleControls(){},updateVisualizationDateControls(){},
  moveReportsContent:id=>calls.push(id),renderReportsView:()=>calls.push('metrics'),ensureIndicatorHistoriesLoaded:async()=>calls.push('metric-history'),
  loadAdministratorPanel:()=>{throw new Error('Unexpected operational data');},refreshAdminExternalAnalysis:()=>{throw new Error('Unexpected note/edit data');}});
 return {app,elements,tabs,panes,notes,calls};
}
test('commercial has only the Metrics navigation and cannot reopen notes or daily detail',async()=>{
 const {app,elements,tabs,panes,notes}=fixture();app.prepareVisualizationPortal();
 for(const requested of ['overview','editions','score-changes','committee','metrics']){await app.switchVisualizationTab(requested);assert.equal(app.visualizationTab,'metrics');}
 app.switchReportsSubtab('daily');assert.equal(app.reportsSubtab,'metrics');
 assert.deepEqual(tabs.filter(t=>!t.classList.contains('hidden')).map(t=>t.dataset.visualizationTab),['metrics']);
 assert.deepEqual(panes.filter(p=>p.classList.contains('active')).map(p=>p.id),['visualization-pane-metrics']);
 assert.equal(notes.classList.contains('hidden'),true);assert.equal(elements.get('btn-subtab-daily').classList.contains('hidden'),true);
 assert.equal(elements.get('metrics-view-daily').classList.contains('hidden'),true);assert.equal(elements.get('modal-daily-detail').classList.contains('hidden'),true);assert.equal(elements.get('modal-blocking-kpis').classList.contains('hidden'),true);
 assert.doesNotMatch(elements.get('reports-view-subtitle').textContent,/notas|jornada/);
 // Re-rendering after a filter/live update reapplies access controls.
 notes.classList.remove('hidden');elements.get('btn-subtab-daily').classList.remove('hidden');app.updateReportsAccessControls();assert.equal(notes.classList.contains('hidden'),true);assert.equal(elements.get('btn-subtab-daily').classList.contains('hidden'),true);
});
test('commercial direct entry points neither expose other portals nor run daily downloads',async()=>{
 const {app,elements}=fixture();app.prepareVisualizationPortal=()=>{};
 for(const view of ['landing','administrator','supervisor-hub','supervisor-workspace','validator']){app.showView(view);assert.equal(app.currentView,'visualizations');assert.equal(elements.get('view-administrator').classList.contains('hidden'),true);}
 app.switchSupervisorTab('reports');assert.equal(app.currentView,'visualizations');assert.notEqual(app.currentTab,'reports');
 app.getFilteredAuditsForReports=()=>{throw new Error('Unexpected detail read');};app.renderHistoricalAlertsConsolidated=()=>{throw new Error('Unexpected daily summary');};
 app.renderDailyReportsView();app.renderDailyDetailTable([]);app.openDailyDetailModal('2026-10-19','Chile');await app.openBlockingKpiAnalysis();await app.exportHistoricalAlertsCSV();app.exportConsolidatedExcel();app.exportMultiSheetExcel();
 assert.equal(elements.get('modal-daily-detail').classList.contains('hidden'),true);
});
test('operational visualizers retain their other sheets and daily/notes controls',async()=>{
 const {app,elements,tabs,notes}=fixture('visualizer');app.loadAdministratorPanel=async()=>{};app.refreshAdminExternalAnalysis=async()=>{};app.prepareVisualizationPortal();
 for(const tab of ['overview','editions','score-changes','metrics']){await app.switchVisualizationTab(tab);assert.equal(app.visualizationTab,tab);}
 app.switchReportsSubtab('daily');assert.equal(app.reportsSubtab,'daily');assert.equal(elements.get('btn-subtab-daily').classList.contains('hidden'),false);assert.equal(notes.classList.contains('hidden'),false);
 assert.deepEqual(tabs.filter(t=>!t.classList.contains('hidden')).map(t=>t.dataset.visualizationTab),['overview','editions','score-changes','metrics']);
});
