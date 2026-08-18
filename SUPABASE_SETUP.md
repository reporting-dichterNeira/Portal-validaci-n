# ValidaFlow con Supabase

La aplicación usa Supabase para que supervisores y validadores trabajen desde equipos distintos sobre la misma información.

## Arquitectura

- `profiles`: define las cuentas administrativas y de supervisión.
- `countries` y `studies`: catálogos creados desde el panel Administrador.
- `supervisor_assignments`: asigna un único estudio/país a cada supervisor.
- `validators`: catálogo y códigos únicos de validadores.
- `validator_sessions`: vincula de forma privada una sesión anónima con el código ingresado.
- `audits`: conserva la auditoría importada, su asignación, estado y resultados.
- RLS: el administrador gestiona catálogos y cuentas; cada supervisor sólo ve su estudio/país; cada validador sólo ve sus auditorías.
- `save_audit_progress`: RPC limitada para que un validador sólo cambie el progreso de una auditoría que tiene asignada.
- Realtime: los cambios en `audits` actualizan el avance en los demás equipos sin recargar.

## Configuración del proyecto

1. Aplicar las migraciones de `supabase/migrations`.
2. En Authentication, habilitar `Allow new users to sign up` y `Allow anonymous sign-ins`. Supabase necesita el interruptor global para crear las sesiones anónimas de los validadores. La aplicación no ofrece registro público y RLS no concede acceso a una cuenta que no tenga perfil o código válido.
3. Crear la cuenta administrativa en Authentication > Users con confirmación automática.
4. Promoverla desde el SQL Editor:

   ```sql
   insert into public.profiles (id, role, username, display_name, is_active)
   select id, 'admin'::public.app_role, 'administrador', 'Equipo de Reporting', true
   from auth.users
   where email = 'ADMIN_EMAIL'
   on conflict (id) do update
     set role = excluded.role,
         username = excluded.username,
         display_name = excluded.display_name,
         is_active = excluded.is_active;
   ```

5. Copiar la URL y la clave publicable del proyecto en `js/supabase-config.js`.
6. No colocar nunca una clave `secret` o `service_role` en archivos del navegador.

## Flujo operativo

1. El administrador crea países y estudios.
2. El administrador crea cada supervisor, su contraseña temporal y la asignación de estudio/país. La función `manage-supervisors` conserva la clave privilegiada exclusivamente en el servidor.
3. El supervisor inicia sesión con su usuario y contraseña; sólo recibe el alcance asignado.
4. Carga el Excel y ejecuta la repartición. La carga se guarda en lotes en Supabase.
5. El validador ingresa su código único desde otro equipo.
6. Sólo recibe sus auditorías. Al abrir, guardar o completar una auditoría, el avance se persiste.
7. El panel del supervisor recibe el cambio por Realtime y recalcula el avance del validador.

Los códigos iniciales se generan durante la migración y se muestran al supervisor en la tabla de validadores. Los nuevos códigos contienen ocho caracteres aleatorios además del prefijo `VAL-`.
