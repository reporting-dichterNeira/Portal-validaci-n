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

El corte diario del mes vigente se publica automáticamente al terminar la
consulta y la comprobación de cantidad de filas. Si falla una carga, el último
corte publicado permanece visible y el job reintenta al día siguiente. El
cierre del mes anterior también se publica automáticamente. **Consultar carga**
permite ver el estado sin aprobar nada. La carga manual de Excel o CSV permanece
como respaldo **solo para el mes vigente** y requiere una acción explícita del
supervisor. Los meses anteriores se muestran como histórico fijo en el portal.

La credencial de Databricks **no** se guarda en Supabase. El notebook lee una
clave de recepción del scope `validaflow-export-general`. En el plan actual de
Databricks, las ACL de jobs y scopes no permiten aislar esa clave por usuario:
las personas con acceso al workspace podrían leerla. La clave permite publicar
el mes vigente y cerrar el mes anterior cuando el calendario cambió; no permite
reabrir meses cerrados. Como no hay revisión previa, una carga incorrecta con
esa clave podría llegar al panel. Es importante limitar el acceso al workspace
y revisar sus usuarios. Si se habilitan ACL en el futuro, restringir el scope
y el job será prioritario.

La implementación está en `databricks/validaflow_general_export.py`,
`supabase/functions/sync-databricks-export/index.ts` y las migraciones
`20260929143445_databricks_general_export_sync.sql` y
`20260929172300_databricks_staged_review.sql` y
`20260929201144_freeze_monthly_databricks_exports.sql` y
`20260929203815_auto_publish_current_databricks_month.sql` y
`20260929205712_grant_databricks_publisher_tables.sql`. Esta última concede
los permisos de escritura necesarios solo a `service_role` sobre las dos
tablas del Export general; no expone los datos a visitantes anónimos.

El comparativo por canal y segmento usa la columna literal `segmento` de
Databricks, independiente de `subcanal_modelo`. El notebook, el receptor y el
publicador conservan ese campo. `supabase/sql/channel-segment-comparison.sql`
agrega la columna y habilita el desglose agregado mediante
`include_channel_segments`, con los mismos permisos y filtros del total
levantado. Las filas se agrupan por estudio, canal y segmento; incluyen los
mismos indicadores de la comparación territorial y se pueden descargar en CSV.
Sin segmento se muestra «Sin segmento identificado», sin inferirlo del canal
o del subcanal.

Para completar el segmento de los cortes anteriores se puede cruzar una
consulta de metadatos por mes e ID de auditoría. Solo se aceptan cruces con un
único segmento no vacío, conservando una copia privada del valor anterior.
Este enriquecimiento modifica únicamente `segmento`: no vuelve a publicar el
corte, no modifica cantidades o decisiones y no reabre meses cerrados.
