# Indicadores integrados y gestión de pendientes

La integración incorpora 13 indicadores de Alertas Bloqueantes en los apartados existentes de Métricas Operacionales y Métricas Ejecutivas. Los 10 indicadores sin fuente o definición suficiente permanecen identificados como pendientes. Smart mantiene su validación sin tipología obligatoria; el gestor de pendientes funciona en ambos módulos.

## Indicadores y fechas

Operación muestra cobertura, aplicación, rechazo, antigüedad de pendientes, dos tramos de tiempo, carga por dimensiones, recurrencia de auditores y motivos de No aplica. El resumen mensual incorpora tendencias, benchmark, desglose por región/canal/subcanal y variables con mayor rechazo. El catálogo explica cada denominador.

Los filtros existentes de estudio, país y fecha limitan el alcance. Los nuevos filtros de región, canal, subcanal y mes refinan los indicadores. La jornada determina el periodo de la carga; la fecha original de auditoría determina la antigüedad. Auditoría → carga usa una muestra por auditoría, mientras carga → decisión usa una por alerta decidida. Fechas sin hora se miden en días calendario; timestamps completos permiten horas transcurridas. Faltantes, fechas futuras y secuencias negativas se muestran aparte, sin inventar valores.

La base diaria tiene prioridad. El Export general enriquece por ID numérico de auditoría; cruces ambiguos no eligen la primera fila. Databricks envía `region` y `subcanal`, y el receptor guarda `region` y `subchannel`. Las consultas siguen usando únicamente Reporting Cluster, el mes vigente y el cierre pendiente del mes anterior. No se republica el histórico cerrado para rellenar nuevas columnas.

KO usa el país real desde la jornada de octubre de 2026; antes se agrupa sin país identificado. Chile y Lindley conservan Chile y Perú. El CSV de indicadores contiene las alertas del alcance con fechas, dimensiones, decisiones y tipificación; cada pulsación descarga un archivo.

## Pendientes de jornadas anteriores

En Carga y Repartición del supervisor se muestran archivos de jornadas anteriores sin completar. El alcance lo verifican la sesión Supabase, el estudio y el módulo; no depende de filtros de Visualizaciones. El supervisor puede descargar todas o algunas pendientes, reasignarlas a un validador activo compatible o eliminarlas del operativo. La decisión requiere motivo y confirmación.

Eliminar del operativo es un retiro recuperable: no ejecuta DELETE sobre la auditoría. La marca `removed` la excluye de conteos y asignaciones y libera al responsable. El historial protegido guarda el registro previo. Las completadas no se pueden retirar desde este gestor. Reasignar mueve la misma fila a la base activa, conserva ID, decisiones parciales, archivo, fecha y hora originales; no crea otra auditoría. Smart respeta los países habilitados del destino. Se admiten hasta 2.000 auditorías por decisión.

Las nuevas cargas no borran automáticamente pendientes de días anteriores. La última versión aceptada de una base/jornada y un ID único por estudio/módulo determinan los indicadores. Una repetición idéntica conserva decisiones parciales o completas de la última versión aceptada. Un payload de KPIs corregido requiere revisión nueva. Las versiones reemplazadas se retiran con trazabilidad. El seguimiento diario también considera solo la última base por alcance y pagina más de 1.000 registros.

El gestor se puede actualizar manualmente y refresca su caché al volver a renderizar tras un minuto. Después de cargar una base o confirmar una decisión, se invalidan los datos afectados. Si una selección cambió en paralelo, el servidor rechaza toda la decisión y exige consultar nuevamente.

## Seguridad y pruebas

No se añadieron secretos al navegador. Las tablas de historial y respaldos tienen RLS; los snapshots privados no son accesibles a `anon` ni `authenticated`. Los RPC públicos nuevos son invocadores; las mutaciones privilegiadas residen en `private`, verifican sesión y alcance y serializan cargas y decisiones. Una pestaña de validador antigua no puede guardar una auditoría retirada.

Los scripts `supabase/sql/integrate-demo-indicators.sql` y `indicator-export-context.sql` son el registro del despliegue aplicado mediante el editor autorizado de Supabase cuando el acceso del conector/CLI al proyecto no estaba disponible. No modifican migraciones anteriores. No deben aplicarse automáticamente en otros entornos sin revisión.

Pruebas locales: `node --test tests/*.test.cjs`. Las vistas completas con datos sintéticos se sirven con `node tests/visualization-preview.cjs` (8772); para supervisor, `PREVIEW_ROLE=supervisor` y `PREVIEW_PORT=8773`. Estos servidores sustituyen el backend y nunca envían datos a Supabase. Los scripts `test-demo-indicators.sql` y `test-demo-reuploads.sql` ejercitan los RPC y RLS reales dentro de transacciones revertidas.

## Restauración

La versión previa es el commit `e14d37ba7b1b862156b85bfdd6f66c2a76399e44`, conservado en la etiqueta `backup-before-demo-2026-10-10` y en la rama `codex/restore-before-demo-2026-10-10`. También hay un ZIP y un Git bundle en la carpeta local de respaldos del proyecto.

Para volver a su interfaz, crear una rama desde la etiqueta, revisar las diferencias, conservar el filtro de retiradas en el backend y publicar una reversión como commit nuevo en `main`. No usar reset forzado ni borrar commits. Probar primero en un entorno aislado. Restaurar solamente HTML/JS no equivale a restaurar el flujo completo de datos: las marcas de retiro, reasignaciones y decisiones nuevas deben seguir respetándose.

Antes de modificar el backend se guardaron 11.243 auditorías, 88 bases y las definiciones previas de funciones en `private.demo_rollout_audits_backup`, `private.demo_rollout_batches_backup` y `private.demo_rollout_functions_backup`. La copia exacta del receptor anterior está en `docs/rollback-sync-before-demo.txt`. Supabase también conserva su backup diario físico; el disponible del 10 de octubre se generó a las 07:52:16 UTC.

La recuperación de filas retiradas se hace por una administradora usando el registro previo de `pending_audit_decisions`, comprobando que no haya una versión nueva del ID. No restaurar masivamente los snapshots sobre datos actuales: borraría trabajo posterior. Una restauración de base completa, de funciones antiguas o del trigger de eliminación automática necesita una decisión administrativa explícita y un plan para conservar los cambios posteriores. Este despliegue no reinstala ese trigger ni borra auditorías.
