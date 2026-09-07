# Diccionario de datos y cruces

## 1. Identificadores de cruce

| Análisis | Clave primaria de análisis | Regla |
| --- | --- | --- |
| Export general + ValidaFlow | ID de auditoría | El ID se normaliza a texto numérico. Filas como “Filtros aplicados” se descartan y no pueden aparecer como auditorías. |
| Ediciones + alertas validadas | ID de auditoría | Une las modificaciones y el detalle de preguntas con las decisiones de las alertas de la misma auditoría. |
| Cambio de nota + alertas bloqueantes | ID de auditoría y PDV | Prioriza la relación por auditoría; PDV permite relacionar el sub-KPI del export de notas con el contexto de alertas. |

La coincidencia depende de que los IDs enviados desde Power BI y desde la operación representen el mismo dato. Para los exports generales, el portal conserva únicamente IDs compuestos por dígitos y elimina el sufijo `.0` que puede introducir Excel.

## 2. Entidades operativas de Supabase

| Tabla | Contenido | Campos relevantes |
| --- | --- | --- |
| `profiles` | Usuarios autenticados del portal. | `id`, `username`, `display_name`, `role`, `is_active` |
| `studies` | Catálogo de estudios. | `id`, `name`, `description`, `is_active` |
| `countries` | Catálogo técnico de países/alcances. | `id`, `code`, `name`, `is_active` |
| `supervisor_assignments` | Relación de usuario, estudio, alcance y módulo. | `supervisor_id`, `study_id`, `country_id`, `module` |
| `validators` | Catálogo de validadores y sus códigos. | `id`, `code`, `name`, `study_id`, `is_active` |
| `validator_sessions` | Vínculo privado de una sesión con un código de validador. | `user_id`, `validator_id`, `last_seen_at` |
| `upload_batches` | Cada base operativa subida para una jornada. | `id`, `study_id`, `module`, `operation_date`, `source_filename`, `status`, `created_by` |
| `audits` | Auditorías, asignaciones y resultados. | `external_id`, `batch_id`, `status`, `validation_results`, `audit_date`, `validation_date`, `duration_seconds` |

La fila `audits.validation_results` almacena el resultado de cada alerta/KPI: decisión, tipología y demás datos de validación. El payload de auditoría conserva el contenido importado que se requiere para la experiencia operativa.

## 3. Tipologías de validación

Cada alerta se valida como **Aplica** o **No aplica**. La interfaz exige una de estas tres tipologías para cada decisión:

| Decisión | Tipologías permitidas |
| --- | --- |
| Aplica | `Evidencia de campo confirma la alerta`; `Incumplimiento confirmado en el PDV`; `Desviación crítica que requiere corrección` |
| No aplica | `Falso positivo: evidencia de campo correcta`; `Excepción autorizada por canal o formato`; `Evidencia válida no detectada por la regla` |

## 4. Export general

El archivo procede de Power BI y enriquece la visualización con auditor, PDV, país, ciudad, canal, estudio y fecha de auditoría.

### Encabezados reconocidos

| Dato normalizado | Encabezados aceptados |
| --- | --- |
| ID de auditoría | `ID de audito`, `ID audito`, `ID auditoria`, `ID auditor`, `Audit ID` |
| ID PDV | `ID de PDV`, `ID PDV`, `PDV ID` |
| Nombre PDV | `Nombre de PDV`, `Nombre PDV`, `PDV name` |
| Auditor | `Auditor` |
| País | `Pais`, `Country` |
| Ciudad | `Ciudad`, `City` |
| Canal | `Canal`, `Channel` |
| Fecha de auditoría | `Fecha del audito`, `Fecha de audito`, `Fecha audito`, `Fecha auditoria`, `Audit date` |
| Ola | `Ola`, `Wave` |
| Estudio | `Survey`, `Estudio`, `Study` |
| Nota PDV | `Nota de PDV`, `Nota PDV` |

El portal guarda estos datos en `admin_alert_export_records` y el registro de la carga en `admin_analysis_imports` con `dataset_type = 'alerts'`.

## 5. Export de ediciones

El archivo aporta modificaciones y responsables de primera y última validación para comparar con las alertas que aplicaban.

| Dato normalizado | Encabezados aceptados |
| --- | --- |
| ID de auditoría | `ID auditoria`, `ID auditor`, `ID audito`, `ID de audito`, `Audit ID` |
| Modificaciones | `Modificaciones` |
| Detalle de preguntas editadas | `Detalle por pregunta`, `Detalle pregunta`, `Question detail`, `Details by question` |
| Cambios de estado | `Cambio de estados`, `Status changes` |
| Inicio primera validación | `Inicio primera validacion`, `Inicio primera validaci` |
| Usuario fin primera validación | `Usuario fin 1ra validacion`, `Usuario fin 1ra validaci` |
| Inicio última validación | `Inicio ultima validacion`, `Inicio ultima validaci` |
| Usuario fin última validación | `Usuario fin ult validacion`, `Usuario fin ult validaci` |
| Estudio, país, estado y ola | `Estudio`/`Study`, `Pais`/`Country`, `Estado`/`Status`, `Ola`/`Wave` |

En `Detalle por pregunta`, las preguntas editadas se mantienen separadas por `||`, para poder mostrarlas de forma legible en el detalle de una auditoría. El destino normalizado es `admin_edit_export_records` y su control de carga queda en `admin_analysis_imports` con `dataset_type = 'editions'`.

## 6. Export de cambio de nota (Notas PDV)

Este export ya trae los valores del periodo anterior y el actual; por eso no es necesario subir dos archivos para calcular la variación.

| Dato normalizado | Encabezados reconocidos |
| --- | --- |
| ID de auditoría | `Id auditoria`, `ID auditoria`, `ID audito`, `ID de audito`, `Audit ID` |
| ID PDV | `ID_de_PDV`, `ID de PDV`, `ID PDV`, `PDV ID` |
| Estudio | `Survey`, `Estudio`, `Study` |
| Sub-KPI | `subkpi`, `sub kpi` |
| Nota final anterior | `Nota total mes anterior`, `Nota final ultima medicion` |
| Nota final actual | `Nota total ola actual`, `Nota final mes actual` |
| Nota anterior del sub-KPI | `Obtenido Anterior por subkpi`, `Obtenidos ola anterior`, `Nota subkpi anterior` |
| Nota actual del sub-KPI | `obtenidos`, `nota_subkpi` |
| Contexto | `origen`, `olaID`, `kpi` |

Los datos se guardan en `admin_note_score_records`; el catálogo de cargas por mes está en `admin_note_score_imports`.

### Resultado mostrado por PDV

Para cada PDV, la tabla muestra:

- nota final de la medición anterior;
- nota final de la medición actual;
- si alertó en Bloqueantes;
- decisión/tipología de la alerta cuando existe;
- tres sub-KPIs destacados y su variación.

Si la nota final aumentó, se destacan los tres sub-KPIs con mejor nota actual. Si disminuyó, se destacan los tres con menor nota actual. Cada uno muestra su variación respecto a la nota anterior del mismo sub-KPI. Cuando no hay alerta relacionada, se muestra **No alertó** y **No corresponde**, en vez de “sin decisión”.

## 7. Persistencia por mes

Los tres procesos guardan la versión más reciente de cada mes, no un archivo histórico completo:

| Tipo | Tabla de metadatos | Tabla de registros | Clave de reemplazo |
| --- | --- | --- | --- |
| Export general | `admin_analysis_imports` | `admin_alert_export_records` | `dataset_type = alerts` + `period_month` |
| Ediciones | `admin_analysis_imports` | `admin_edit_export_records` | `dataset_type = editions` + `period_month` |
| Notas PDV | `admin_note_score_imports` | `admin_note_score_records` | `period_month` |

Actualizar agosto, por ejemplo, reemplaza únicamente la versión normalizada de agosto. Septiembre y cualquier otro mes permanecen disponibles.
