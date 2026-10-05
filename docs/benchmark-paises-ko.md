# Benchmark KO por país real

La tabla ejecutiva conserva Chile y Lindley como totales. KO Tradicional CAM y KO
Moderno CAM muestran el total del estudio y las filas por país, abiertas inicialmente.
Cada auditoría pertenece a una sola fila de país. La suma del detalle coincide con
el total de auditorías, alertas, Aplica y No aplica; las tasas se recalculan por país.

## Procedencia y prioridades

1. Nombre de país válido de la base diaria (`pais`, `country` o encabezado PAIS
   dentro de `meta`). Nunca usar el alcance interno GLB ni el código ID_PAIS.
2. Cruce por ID de auditoría normalizado con `admin_alert_export_records`, el
   Export general publicado desde Databricks. Se respeta el estudio identificado
   en Survey. Países duplicados coincidentes no duplican auditorías; un cruce con
   países distintos se deja sin identificar.
3. País histórico recuperado previamente en `payload.benchmark_country`.
4. «Sin país identificado» cuando no hay evidencia suficiente. También cuenta
   en los totales; nunca se adivina un país por canal, ciudad o PDV.

Guatemala Embocen y Guatemala ABVO se agrupan como Guatemala. Se unifican tildes,
mayúsculas y códigos como PA/CR sin confundirlos con códigos numéricos.

Esta solicitud incluye los históricos recuperables **en esta tabla**. El filtro
general de país y las demás vistas conservan el corte por jornada de octubre de
2026 solicitado previamente.

## Carga y acceso

Solo se consultan los IDs faltantes, en bloques de 200 y con un máximo de cuatro
consultas simultáneas. Se solicitan ID, país y estudio, no el Excel completo.
Los datos de la base y el informe se muestran mientras el cruce termina.
Las consultas siguen las políticas RLS existentes de los exports (sin nuevos
permisos). La caché del cruce se limpia al cerrar sesión.

`supabase/sql/recover-ko-benchmark-countries.sql` enriquece auditorías KO
completadas cuyo país original falta o es numérico. Es repetible y conserva
decisiones, validadores, jornadas e IDs. La regla existente de Supabase normaliza
`pais` y convierte códigos numéricos inválidos en vacío; la versión del script
incluye un campo de respaldo para ejecuciones futuras. Guarda el país derivado
y su fuente para que el perfil comercial pueda leer el resultado mediante la
lectura autorizada de auditorías, sin acceder a exports completos.

No consulta Databricks al abrir el panel ni cambia el job del Reporting Cluster:
reutiliza el corte ya publicado en Supabase.

Verificación del 5 de octubre: 1.252 registros de Tradicional y 315 de Moderno
enriquecidos; 9 de Moderno ya tenían país. Todas las 1.576 auditorías KO tenían
un cruce único con el export. La primera ejecución normalizó los códigos
inválidos antes de añadir el respaldo al script; no se recuperaron ni inventaron
esos códigos originales. Los nombres reales quedaron disponibles para el reporte.
