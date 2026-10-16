import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import {SUPABASE_CONFIG} from './supabase-config.js?v=27.0';
import {PqrUI} from './pqr-ui.mjs?v=1.2';

// A dedicated auth storage key keeps PQR login/logout from replacing any
// existing validator, supervisor or visualization session in this browser.
const client=createClient(SUPABASE_CONFIG.url,SUPABASE_CONFIG.publishableKey,{auth:{storageKey:'validaflow-pqr-auth-v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const backend={
 async call(action,data={}){const {data:result,error}=await client.rpc('pqr_api',{p_action:action,p_data:data});if(error)throw new Error(error.code==='42501'?'Tu acceso PQR venció o no permite esta acción. Vuelve a ingresar.':error.message);return result;},
 async restore(){const {data:{session}}=await client.auth.getSession();if(!session)return null;try{return await this.call('context');}catch{return null;}},
 async login(kind,values){
  try{await this.call('logout');}catch{/* No PQR claim exists on the first login. */}
  await client.auth.signOut({scope:'local'});
  if(kind==='admin'){
   const username=values.username.trim().toLowerCase(),email=username.includes('@')?username:username+'@portal-validacion.local';
   const {error}=await client.auth.signInWithPassword({email,password:values.password});if(error)throw new Error('Credenciales de administración inválidas.');
   const context=await this.call('context');if(context.role!=='admin'){await client.auth.signOut({scope:'local'});throw new Error('Este acceso requiere una cuenta de administración.');}return context;
  }
  const {error:authError}=await client.auth.signInAnonymously();if(authError)throw new Error('No fue posible iniciar el acceso PQR. '+authError.message);
  const {data,error}=await client.rpc('pqr_login',{p_kind:kind,p_identifier:values.username||'',p_secret:kind==='analyst'?values.code:values.password});
  if(error||data?.error){throw new Error(data?.error||error?.message||'Acceso PQR no disponible.');}return data;
 },
 async logout(){try{await this.call('logout');}catch{/* An expired PQR session must still be able to sign out. */}finally{await client.auth.signOut({scope:'local'});}}
};
const ui=new PqrUI(document.getElementById('pqr-app'),backend);
ui.init().catch(error=>{document.getElementById('pqr-app').textContent='No fue posible cargar PQR. '+error.message;});
