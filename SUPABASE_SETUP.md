# ValidaFlow con Supabase

La aplicación usa Supabase para que supervisores y validadores trabajen desde equipos distintos sobre la misma información.

## Arquitectura

- `profiles`: define las cuentas administrativas y de supervisión.
- `studies`: catálogo fijo con Tradicional, Moderno, Chile y Lindley.
- `countries`: conserva un único alcance técnico interno (`GLB`) que no se muestra en el portal.
- `supervisor_assignments`: asigna un único estudio a cada supervisor y utiliza internamente el alcance `GLB` para mantener las políticas RLS existentes.
- `validators`: catálogo y códigos únicos de validadores.
- `validator_sessions`: vincula de forma privada una sesión anónima con el código ingresado.
- `audits`: conserva la auditoría importada, su asignación, estado y resultados.
- `upload_batches`: registra cada Excel como una jornada independiente; una base nueva archiva la anterior sin borrarla.
- RLS: el administrador gestiona cuentas; cada supervisor sólo ve su estudio; cada validador sólo ve sus auditorías.
- `save_audit_progress`: RPC limitada para que un validador sólo cambie el progreso de una auditoría que tiene asignada.
- `get_validator_history`: genera en PostgreSQL el resumen por fecha y validador, sin enviar al navegador los JSON completos.
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

1. El administrador selecciona uno de los cuatro estudios disponibles.
2. El administrador crea cada supervisor, su contraseña temporal y la asignación de estudio. La función `manage-supervisors` conserva la clave privilegiada exclusivamente en el servidor y agrega el alcance técnico interno.
   - La contraseña se muestra una sola vez para copiarla; Supabase no permite consultar contraseñas existentes.
   - El administrador puede generar una nueva contraseña o eliminar la cuenta. Al eliminarla, el histórico de auditorías permanece y el acceso se revoca.
3. El supervisor inicia sesión con su usuario y contraseña; sólo recibe el alcance asignado.
4. Carga el Excel y ejecuta la repartición. La carga se guarda en lotes en Supabase.
5. Cada carga diaria crea un lote nuevo. El lote anterior deja de aparecer en la operación activa, pero permanece en el histórico.
   - Durante la importación, los ID de auditoría repetidos dentro del mismo Excel se consolidan antes de insertar el lote. Esto evita conflictos de actualización mientras el lote todavía está en borrador y protegido por RLS.
6. El validador ingresa su código único desde otro equipo.
7. Sólo recibe las auditorías del lote activo. Al abrir, guardar o completar una auditoría, el avance se persiste.
8. El panel del supervisor recibe el cambio por Realtime y recalcula el avance del validador.
9. En Reportes > Histórico semanal por validador se consulta cualquier rango de hasta 366 días.

## Uso eficiente del plan gratuito

- No se crea una fila de bitácora por cada clic: se conserva una fila por auditoría y jornada.
- Los reportes históricos se agregan en la base de datos y devuelven sólo totales diarios por validador.
- La aplicación consulta únicamente el lote activo durante la operación normal.
- Realtime escucha cambios de progreso y una sola activación de lote, evitando refrescos por cada fila histórica.
- Las jornadas y los validadores se archivan o desactivan; no se duplican resultados en tablas auxiliares.

Los códigos iniciales se generan durante la migración y se muestran al supervisor en la tabla de validadores. Los nuevos códigos contienen ocho caracteres aleatorios además del prefijo `VAL-`.
