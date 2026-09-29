# Export general desde Databricks

El job de Databricks `756446805871267` se ejecuta cada día a las 5:00 a. m.
de Bogotá **solo en Reporting Cluster** (`1115-192254-jqnbpmi`). Su primera
tarea enciende el clúster (si estaba apagado) y verifica que Spark responda;
solo después se ejecuta
`/Users/masanchez@dichter-neira.com/validaflow-general-export-sync`.
La programación admite el tiempo de arranque del clúster antes de consultar
`storeview.slv_sv_ceres_ag_export` para KO Tradicional, KO Moderno y Lindley.

Durante el mes se consulta **únicamente el mes vigente**. Al comenzar el mes
siguiente, la primera ejecución toma un último corte del mes anterior, lo
publica y marca ese mes como cerrado; después pasa al nuevo mes. Si falla el
cierre, se reintenta en la siguiente ejecución diaria. Una vez cerrado, no se
consulta ni se reemplaza de nuevo automáticamente. Los meses anteriores a
septiembre de 2026 quedan fijos desde la puesta en marcha de este flujo.

Para la carga diaria del mes vigente, un supervisor o administrador selecciona
el mes en **Export general**, comprueba el total y la muestra y pulsa
**Publicar base revisada**. Hasta esa aprobación, los datos visibles no
cambian. El cierre del mes anterior se publica automáticamente, como último
corte, sin ese paso de revisión. La carga manual de Excel o CSV permanece como
respaldo y requiere una acción explícita del supervisor.

La credencial de Databricks **no** se guarda en Supabase. El notebook lee una
clave de recepción del scope `validaflow-export-general`. En el plan actual de
Databricks, las ACL de jobs y scopes no permiten aislar esa clave por usuario:
las personas con acceso al workspace podrían leerla. La clave permite dejar
pendiente de revisión el mes vigente y publicar **solo** el cierre del mes
anterior cuando el calendario cambió, no reabrir meses cerrados. Esto reduce
el alcance, pero la publicación automática del cierre hace importante limitar
el acceso al workspace y revisar sus usuarios. Si se habilitan ACL en el
futuro, restringir el scope y el job será prioritario.

La implementación está en `databricks/validaflow_general_export.py`,
`supabase/functions/sync-databricks-export/index.ts` y las migraciones
`20260929143445_databricks_general_export_sync.sql` y
`20260929172300_databricks_staged_review.sql` y
`20260929201144_freeze_monthly_databricks_exports.sql`.
