const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getStudyDisplayName}=require('./study-labels-fixture.cjs');
test('Chile cambia de nombre solo para presentación y admite distintas capitalizaciones',()=>{
  for(const key of ['Chile','CHILE','chile',' CHile '])assert.equal(getStudyDisplayName(key),'KO Tradicional CHILE');
  assert.equal(getStudyDisplayName('Tradicional'),'KO Tradicional CAM');
  assert.equal(getStudyDisplayName('Moderno'),'KO Moderno CAM');
  assert.equal(getStudyDisplayName('Lindley'),'Lindley');
});
