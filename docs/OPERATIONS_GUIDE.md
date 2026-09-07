# Guía operativa

## 1. Administrador

### Crear o reasignar acceso

1. Inicie sesión como administrador y abra **Administración**.
2. Cree el usuario o use **Reasignar** en uno existente.
3. Seleccione el rol: Operaciones, Visualizaciones o Comercial.
4. Para Operaciones, marque uno o más estudios y uno o ambos módulos: **Validación Smart** y **Alertas Bloqueantes**.
5. Guarde el acceso y confirme el mensaje de la plataforma.

La reasignación sustituye el conjunto previo de estudios y módulos del usuario por la selección guardada. Una cuenta Comercial conserva solo las vistas comerciales; una cuenta de Visualizaciones consulta las vistas operativas sin administrar usuarios.

### Controlar quién cargó una base

En Administración, la sección de bases cargadas muestra el responsable real de la carga. El dato proviene de `upload_batches.created_by` y se resuelve con el perfil visible del usuario, por lo que no depende de un valor fijo mostrado en pantalla.

## 2. Supervisor de operaciones

### Cargar y repartir auditorías

1. Entre a su estudio y módulo asignado.
2. En **Cargar auditorías**, seleccione un Excel o CSV de Power BI.
3. Revise la cantidad detectada y los validadores disponibles.
4. Ejecute la distribución. El algoritmo balancea tanto el número de auditorías como la cantidad de KPIs alertados.
5. Active la jornada cuando la distribución sea correcta.

Al cargar una jornada nueva, la anterior se archiva para conservar el historial. El sistema puede trasladar las auditorías pendientes según la decisión tomada en la operación.

### Reasignar pendientes a varios validadores

1. Abra la acción de reasignación de auditorías pendientes.
2. Seleccione una o más personas destino.
3. Confirme la distribución.

Las pendientes se reparte entre todos los validadores seleccionados; no se asignan duplicados de la misma auditoría.

## 3. Validador

1. Ingrese al portal de validación con su código `VAL-...`.
2. Abra una auditoría pendiente.
3. Para cada alerta, seleccione **Aplica** o **No aplica**.
4. Seleccione la tipología correspondiente; esta es obligatoria para guardar la decisión.
5. Guarde o complete la auditoría.

El validador solo ve sus auditorías activas. El portal registra las horas de inicio y finalización, el tiempo dedicado y las decisiones tomadas. El botón **Descargar Excel** entrega su resumen diario de productividad.

## 4. Panel de Visualizaciones

La barra de segmentación distingue:

- **Consolidado:** ambos módulos.
- **Bloqueantes:** solo alertas bloqueantes.
- **Smart:** solo alertas de Validación Smart.

La pestaña **Cambio de nota** no usa esta segmentación, porque analiza directamente las notas de PDV y su cruce con alertas bloqueantes.

### Export general

1. Abra **Export general**.
2. Seleccione el mes de referencia y el archivo exportado desde Power BI.
3. Pulse **Cargar export general**.
4. Use los filtros por estudio y auditor; la tabla puede descargarse con los filtros activos.

El listado de “Exports generales cargados” muestra el archivo, mes, fecha de carga y botón **Actualizar**. Actualizar reemplaza solo el mes elegido.

### Ediciones

1. Abra **Ediciones**.
2. Elija el mes y cargue el export de modificaciones.
3. Consulte la tarjeta de cumplimiento de alertas que aplicaban y los filtros de auditorías con alerta aplicable sin edición.
4. Abra **Ver detalle** para revisar las alertas con decisión y las preguntas editadas separadas por `||`.

### Cambio de nota

1. Abra **Cambio de nota**.
2. Seleccione el mes y cargue el export **Notas PDV**.
3. Use filtros por mes, estudio, estado de alerta bloqueante, aplicabilidad y dirección de variación.
4. Descargue la tabla filtrada si debe compartir el resultado.

No se requiere cargar un archivo del mes anterior: el formato vigente contiene las notas totales y de sub-KPI de ambas mediciones.

### Métricas y exportaciones

El usuario de Operaciones puede alternar entre métricas operativas y la vista de comité/comercial. Desde allí puede descargar el consolidado y el libro con hojas por día. El usuario Comercial mantiene exclusivamente su visual comercial.

## 5. Fuente de los exports

El botón **Abrir Power BI** de Visualizaciones conduce al [reporte compartido de Power BI](https://app.powerbi.com/links/ZRtorqXOu3?ctid=05e4f087-3719-4046-8fa3-286b1f5110f2&pbi_source=linkShare&bookmarkGuid=df97ad57-04d6-4fe5-94b9-8fd0d764a36d) desde el que se descargan los tres exports mensuales.

Antes de cargar, confirme:

- que el mes seleccionado corresponde al archivo;
- que los encabezados se conservan;
- que el export contiene filas de datos, no solo filtros o subtotales;
- que el ID de auditoría o ID PDV esté presente según el tipo de archivo.

## 6. Mensajes frecuentes

| Mensaje | Acción recomendada |
| --- | --- |
| “Selecciona el mes de referencia” | Elija el mes antes de presionar Cargar. |
| “No hay alertas para el estudio seleccionado” | Revise el filtro y confirme que el export de ese mes incluía ese `Survey`/estudio. |
| “No alertó / No corresponde” | Ese sub-KPI no encontró una alerta bloqueante equivalente; no es una decisión pendiente del validador. |
| “Failed to send a request to the Edge Function” | Revise el despliegue de `manage-supervisors`, las variables de entorno y la sesión de administrador. |
| La primera carga tarda | Es normal con un export grande. Las siguientes aperturas usan primero la caché local del navegador. |
