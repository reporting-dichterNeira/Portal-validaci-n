# Eliminar un validador del estudio

Cada tarjeta tiene **Eliminar del estudio**. Requiere confirmación y solo quita al validador del listado del estudio/alcance seleccionado, tanto en Smart como en Bloqueantes. No borra su identidad, código, países configurados ni auditorías históricas; no altera otros estudios.

Si hay auditorías pendientes o en progreso en una base activa de cualquiera de los dos módulos, la eliminación se bloquea. Usa Reasignar pendientes y termina las auditorías abiertas antes de quitarlo. Las completadas se conservan y no bloquean la operación.

La eliminación es recuperable: Añadir validador → Validador existente permite devolverlo al mismo estudio, con el mismo código y países. Esta recuperación también funciona cuando era su único estudio y quedó globalmente inactivo.

## Persistencia y seguridad

- `validator_study_memberships.removed_at`: marca recuperable; `is_active=false` evita nuevos repartos.
- El listado consulta `removed_at IS NULL` dentro de su alcance y bajo las políticas RLS existentes.
- `public.remove_study_validator` es SECURITY INVOKER y delega a una función privada que comprueba `auth.uid()` y el alcance del supervisor. `anon` no puede ejecutarla.
- La operación bloquea identidad, membresía y trabajo sin terminar antes de comprobarlo. Un trigger impide que un navegador con una lista obsoleta asigne nuevas auditorías al miembro eliminado.
- Los controles de activación no restauran miembros eliminados; la restauración se realiza por la opción de añadir existente.
- No se concede DELETE ni se eliminan registros de usuarios, sesiones o auditorías.

Pruebas: `node --test tests/*.test.cjs` y `supabase/sql/test-remove-study-validator.sql` (fixtures transaccionales revertidos).
