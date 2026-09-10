const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../js/supabase-backend.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class SupabaseBackend', 'class SupabaseBackend');
const context = vm.createContext({ SUPABASE_CONFIG: {}, console });
vm.runInContext(code + '\nthis.Backend = SupabaseBackend;', context);
function backend(client) {
  return Object.assign(Object.create(context.Backend.prototype), {
    configured: true, client, currentScope: { study: { id: 'study-2', name: 'Moderno' }, country: { id: 'country-2' } }
  });
}
test('saving assignments never overwrites a persisted shared identity', async () => {
  const b = backend({ from() { throw Error('Unexpected identity write'); } });
  await b.upsertValidators([{ id: 'shared', _persisted: true, estudio: 'Moderno' }]);
});
test('only new validators are persisted, and failed writes are not marked saved', async () => {
  let rows;
  const b = backend({ from: () => ({ upsert: async values => { rows = values; return { error: null }; } }) });
  const validator = { id: 'new', name: 'Example', code: 'VAL-EXAMPLE1', estudio: 'Moderno' };
  await b.upsertValidators([validator]);
  assert.equal(rows[0].study_id, 'study-2'); assert.equal(validator._persisted, true);
  b.client.from = () => ({ upsert: async () => ({ error: new Error('Offline') }) });
  const failed = { ...validator, id: 'failed', _persisted: false };
  await assert.rejects(b.upsertValidators([failed]), /Offline/);
  assert.equal(failed._persisted, false);
});
test('study roster preserves code/id while presenting local study and activity', async () => {
  const source = { id: 'shared', name: 'Example', code: 'VAL-EXAMPLE1', study: 'Chile', is_active: true };
  const filters = [];
  const query = { select() { return this; }, eq(k,v) { filters.push([k,v]); return this; },
    then(resolve) { resolve({data:[{is_active:false,validators:source}],error:null}); } };
  const b = backend({ from: name => { assert.equal(name,'validator_study_memberships'); return query; } });
  const [result] = await b.loadScopeValidators();
  assert.equal(result.id,'shared'); assert.equal(result.code,source.code);
  assert.equal(result.estudio,'Moderno'); assert.equal(result.isActive,false);
  assert.equal(source.study,'Chile'); assert.equal(source.is_active,true);
  assert.deepEqual(filters,[['study_id','study-2'],['country_id','country-2']]);
});
test('adding sends only identity and destination; no audit or code mutation', async () => {
  const calls=[];
  const b=backend({rpc:async(name,args)=>{calls.push({name,args});return {error:null};}});
  b.loadScopeValidators=async()=>[{id:'shared',code:'VAL-EXAMPLE1'}];
  const result=await b.addExistingStudyValidator('shared');
  assert.equal(result.code,'VAL-EXAMPLE1');
  assert.equal(calls[0].name,'add_existing_study_validator');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)),{p_validator_id:'shared',p_study_id:'study-2',p_country_id:'country-2'});
});
test('membership errors propagate and do not report a false success', async () => {
  const b=backend({rpc:async()=>({error:new Error('SUPERVISOR_SCOPE_REQUIRED')})});
  b.loadScopeValidators=()=>{throw Error('Should not refresh after a failed mutation');};
  await assert.rejects(b.addExistingStudyValidator('shared'),/SUPERVISOR_SCOPE_REQUIRED/);
  await assert.rejects(b.setValidatorActive('shared',false),/SUPERVISOR_SCOPE_REQUIRED/);
});
