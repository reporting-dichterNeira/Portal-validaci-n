# Asignación Smart por país

En Supervisores → Smart → KO Tradicional CAM o KO Moderno CAM, cada tarjeta
de validador tiene **País a revisar en Smart**. Elegir el país y pulsar
**Activar** guarda el país y activa al validador. Para uno ya activo, usar
**Guardar país y repartir pendientes**. **Todos los países** conserva el
reparto sin restricción.

**Ver países asignados** despliega los países de las auditorías realmente
asignadas en la base actual, con total, completadas y por terminar por país.
Si no tiene casos, informa que todavía no hay auditorías asignadas. No se
confunde esta lista con la preferencia de país guardada para futuros repartos.

La selección es propia del estudio, compartida entre supervisores y conservada
en `validator_study_memberships.smart_country`; no cambia el código del
validador ni sus otros estudios. Bloqueantes no usa esta restricción. El
reparto nuevo, la redistribución de pendientes y la reasignación manual Smart
respetan el país. Si no existe destino habilitado, el reparto general deja la
auditoría sin asignar; la reasignación manual pide corregir los destinos sin
mover parcialmente la base. No se redistribuyen completadas ni en progreso.
Un cambio de país incompatible con auditorías en progreso se rechaza.

## Origen y persistencia del país

- KO: encabezados `pais`, `País`, `country`, `country_name`, `nombre_pais`,
  `pais_nombre`, `Nombre del país`, `País del PDV` o `pais_pdv`, cualquiera
  que sea la posición. Si no hay encabezado reconocido: D en el formato
  Bloqueantes por filas y F en Smart columnar. `ID_PAIS` numérico no es país.
- Lindley: siempre `Perú`.
- Chile: siempre `Chile`.

El nombre real se conserva en `audits.payload.pais`, tanto en el cliente como
en el trigger de Supabase. `audits.country_id` conserva el alcance de acceso
del supervisor (puede ser GLB): no reemplaza el nombre del país en métricas.
Las métricas y sus filtros usan `payload.pais` normalizado. Se mantiene la
regla histórica: país visible desde la jornada de carga `2026-10-01`; jornadas
hasta septiembre no muestran el desglose de país. Lindley/Chile antiguos se
normalizan al leer sin modificar masivamente el histórico.

## Base de datos y verificación

Migración: `20261005191540_smart_validator_country_assignment.sql`.
Los nuevos RPC públicos son security invoker y delegan en funciones privadas
con autorización por supervisor, estudio, alcance y módulo. La tabla mantiene
su RLS y permisos existentes; no se concede acceso anónimo. El trigger rechaza
asignar Smart a un país incompatible y países numéricos en cargas KO desde
octubre, incluso si se evita la interfaz.

Pruebas: `node --test tests/*.test.cjs` y
`supabase/sql/test-smart-country-assignment.sql` (fixtures transaccionales
revertidos; ejecutar como postgres en SQL Editor). La prueba visual aislada
del selector no usa cuentas ni asignaciones reales.
