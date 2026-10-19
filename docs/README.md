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
