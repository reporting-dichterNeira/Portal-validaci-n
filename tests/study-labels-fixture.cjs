const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/study-labels.js'),'utf8').replace(/^export /gm,''),context);
module.exports=context.PortalStudyLabels;
