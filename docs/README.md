# Índice de documentación

Esta carpeta reúne la documentación vigente del Portal de Validación y Control de Calidad.

| Documento | Para qué sirve |
| --- | --- |
| [Arquitectura](ARCHITECTURE.md) | Entender las capas del sistema, la autenticación, las reglas de acceso y el rendimiento. |
| [Diccionario de datos](DATA_DICTIONARY.md) | Preparar correctamente los exports e identificar las tablas y reglas de cruce. |
| [Guía operativa](OPERATIONS_GUIDE.md) | Usar el portal según el rol de administrador, supervisor, validador o visualizador. |
| [Despliegue y mantenimiento](DEPLOYMENT_AND_MAINTENANCE.md) | Publicar cambios, aplicar migraciones, depurar y operar de forma segura. |
| [Indicadores y pendientes](INDICATORS_AND_PENDING.md) | Consultar indicadores, gestionar pendientes y restaurar la versión anterior sin perder trabajo posterior. |
| [Configuración inicial de Supabase](../SUPABASE_SETUP.md) | Crear el primer administrador y configurar el proyecto Supabase. |

La documentación describe el estado del código almacenado en este repositorio. Las migraciones de `supabase/migrations/` son la fuente técnica de referencia para el esquema y las políticas de la base de datos.

## Comprobación de conexiones

`supabase/sql/test-portal-connections.sql` comprueba totales, metadatos, histórico
de ambos módulos y contexto PQR con permisos reales de `authenticated`. También
verifica las 27 funciones utilizadas por el portal y las tablas publicadas en
Realtime. Solo escribe tablas temporales y termina con `ROLLBACK`.

`supabase/sql/optimize-audit-history.sql` añade un índice por módulo e ID para
la paginación histórica, sin bloquear las escrituras durante su creación. Las
lecturas históricas reintentan solo la página fallida ante errores temporales y
renuevan la sesión si venció. Los errores persistentes se muestran y evitan
descargar un histórico incompleto; no se reintentan escrituras con este mecanismo.

Las métricas preparan las auditorías recibidas una sola vez y luego separan
Smart y Bloqueantes. La normalización de encabezados se comparte entre las
filas del export, y los metadatos ya resueltos se reutilizan mientras no cambie
la fuente. La caché del histórico durante el render se descarta al terminar,
incluido si hay un error, para conservar las actualizaciones posteriores.

## Memoria del inventario de Databricks

`supabase/sql/cache-metrics-inventory.sql` conserva en tablas privadas los IDs,
fechas y dimensiones verificadas de cada corte. Agosto y septiembre se leen una
vez y se reutilizan. El trabajo programado `metrics-inventory-current-month`
comprueba solo el mes actual cada cinco minutos y lo actualiza si cambió la
versión del import o del catálogo verificado. La actualización es atómica.

`supabase/sql/use-cached-metrics-inventory.sql` compara la respuesta completa
del lector anterior con la nueva, incluidos territorios, auditores, canales,
segmentos y filtros de fechas. Solo cambia el lector si coinciden. Conserva su
autorización y un respaldo privado de la definición anterior. Los conteos
siguen usando IDs distintos por estudio sobre todos los meses seleccionados;
no se suman porcentajes ni totales mensuales que puedan duplicar auditorías.

Los datos originales y las decisiones no se modifican. Incidencia se excluye
al construir el corte; la regla de región/canal faltantes y alertas bloqueantes
se evalúa con las auditorías operativas existentes. La RPC pública mantiene su
contrato y los filtros. Las tablas de memoria tienen RLS y no son accesibles
directamente por usuarios del portal.

`supabase/sql/test-cached-metrics-inventory.sql` comprueba permisos, reutilización
del histórico, programación y resultados por mes y país. Una corrección
extraordinaria de un mes cerrado se puede reconstruir desde SQL con
`private.refresh_metrics_inventory_month('2026-08-01', true)`; la actualización
normal del portal no vuelve a consultar esos meses.

El histórico operativo también se carga por lotes visibles, con un máximo de
dos páginas simultáneas por módulo. Así se evita recorrer Bloqueantes para
encontrar Smart. Se conservan RLS, el alcance del supervisor, las fechas y
archivos originales, el orden final por ID y los reintentos de la página fallida.
