# Export general desde Databricks

El job de Databricks `756446805871267` ejecuta el notebook
`/Users/masanchez@dichter-neira.com/validaflow-general-export-sync` **solo en
Reporting Cluster** (`1115-192254-jqnbpmi`). Consulta
`storeview.slv_sv_ceres_ag_export` para KO Tradicional, KO Moderno y Lindley,
prepara el mes actual y el anterior y envía los registros por lotes al área de
revisión de Supabase `portal-validacion`. No publica los datos por sí mismo.

En el portal, un supervisor o administrador selecciona el mes en **Export
general**, comprueba el total y la muestra y pulsa **Publicar base revisada**.
Solo entonces se reemplaza atómicamente la versión visible de ese mes. Las
bases anteriores permanecen disponibles hasta esa aprobación. La carga manual
de Excel o CSV queda como respaldo.

La credencial de Databricks **no** se guarda en Supabase. El notebook lee una
clave de recepción del scope `validaflow-export-general` y esta solo puede
iniciar una carga pendiente de revisión; no permite publicarla. En el plan
actual de Databricks, las ACL de jobs y scopes no permiten aislar esa clave
por usuario. Por ello, las personas con acceso al workspace podrían leerla.
El servicio receptor solo admite el mes actual o anterior y exige una revisión
autenticada antes de publicar. Si se habilitan ACL en el futuro, limitar el
acceso al scope y al job será una mejora importante.

La implementación está en `databricks/validaflow_general_export.py`,
`supabase/functions/sync-databricks-export/index.ts` y las migraciones
`20260929143445_databricks_general_export_sync.sql` y
`20260929172300_databricks_staged_review.sql`.
