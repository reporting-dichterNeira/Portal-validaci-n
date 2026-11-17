import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import {SUPABASE_CONFIG} from './supabase-config.js?v=27.0';
import {PqrUI} from './pqr-ui.mjs?v=2.2';
import {qualityBackend} from './quality-backend.mjs?v=1.0';

// A dedicated auth storage key keeps PQR login/logout from replacing any
// existing validator, supervisor or visualization session in this browser.
const client=createClient(SUPABASE_CONFIG.url,SUPABASE_CONFIG.publishableKey,{auth:{storageKey:'validaflow-pqr-auth-v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const backend=qualityBackend(client);
const ui=new PqrUI(document.getElementById('pqr-app'),backend);
ui.init().catch(error=>{document.getElementById('pqr-app').textContent='No fue posible cargar PQR. '+error.message;});
