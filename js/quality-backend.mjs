// One staff session can manage both operations; analyst sessions are scoped by
// the database. Selecting a sheet never logs out or changes a PQR assignment.
export function qualityBackend(client,storage=globalThis.localStorage){
 const backend={
  operation:storage?.getItem('portal-quality-operation')==='qa'?'qa':'pqr',
  setOperation(operation){if(!['pqr','qa'].includes(operation))throw new Error('Operación inválida.');this.operation=operation;storage?.setItem('portal-quality-operation',operation);},
  async call(action,data={}){const {data:result,error}=await client.rpc(this.operation+'_api',{p_action:action,p_data:data});if(error)throw new Error(error.code==='42501'?'Tu acceso venció o no permite esta acción. Vuelve a ingresar.':error.message);return result;},
  async restore(){const {data:{session}}=await client.auth.getSession();if(!session)return null;for(const operation of [this.operation,this.operation==='qa'?'pqr':'qa']){this.setOperation(operation);try{const context=await this.call('context');if(context)return context;}catch{/* An analyst session belongs to exactly one operation. */}}return null;},
  async login(kind,values){
   try{await this.call('logout');}catch{/* No quality session on first login. */}
   await client.auth.signOut({scope:'local'});
   this.setOperation(kind==='qa'?'qa':'pqr');
   if(kind==='admin'){
    const username=values.username.trim().toLowerCase(),email=username.includes('@')?username:username+'@portal-validacion.local';
    const {error}=await client.auth.signInWithPassword({email,password:values.password});if(error)throw new Error('Credenciales de administración inválidas.');
    const context=await this.call('context');if(context.role!=='admin'){await client.auth.signOut({scope:'local'});throw new Error('Este acceso requiere una cuenta de administración.');}return context;
   }
   const {error:authError}=await client.auth.signInAnonymously();if(authError)throw new Error('No fue posible iniciar el acceso. '+authError.message);
   const {data,error}=await client.rpc(this.operation+'_login',{p_kind:kind==='qa'?'analyst':kind,p_identifier:values.username||'',p_secret:kind==='analyst'||kind==='qa'?values.code:values.password});
   if(error||data?.error)throw new Error(data?.error||error?.message||'Acceso no disponible.');return data;
  },
  async logout(){try{await this.call('logout');}finally{await client.auth.signOut({scope:'local'});}}
 };
 return backend;
}
