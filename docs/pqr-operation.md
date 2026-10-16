# Operación de control de calidad PQR

Acceso: `pqr.html`, desde el botón **Control de calidad PQR** de la portada.
La página, su sesión y sus datos son independientes del flujo existente.
No modifica perfiles, políticas, asignaciones, respuestas ni RPCs de los validadores actuales.

## Puesta en marcha

1. En PQR, abrir **Administrar accesos PQR** e ingresar con una cuenta administrativa existente.
2. Crear la cuenta independiente de la supervisora PQR, con un usuario y una contraseña de al menos 8 caracteres. El usuario se normaliza a minúsculas.
3. La supervisora entra por **Supervisión PQR**, configura el porcentaje y crea los analistas.
4. Entregar cada código a su analista. Supervisión puede recuperarlo con **Copiar código**; se conserva cifrado en Supabase Vault y su hash se usa para autenticar. La lista y las descargas nunca incluyen el código.
5. Una vez listo el equipo, pulsar **Distribuir pendientes de hoy**. En adelante el reparto se actualiza automáticamente.

Pausar reparto excluye al analista de nuevas asignaciones y permite terminar sus revisiones actuales.
La desactivación revoca acceso; no se permite si tiene una revisión en curso.
Un código nuevo invalida las sesiones abiertas con el anterior.
Los códigos anteriores que solo tenían hash se conservan sin cambios. Su copia se habilita al ingresar el analista con su código actual, o al generar uno nuevo expresamente desde el botón. Copiar un código ya disponible no lo regenera ni cierra sesiones.
**Eliminar analista** lo retira del equipo y revoca su acceso, conservando las revisiones terminadas. Sus pendientes sin iniciar vuelven al reparto; no se permite eliminarlo si tiene una revisión en curso. **Analistas eliminados** permite restaurarlo como inactivo; se debe generar un código nuevo y activarlo para que vuelva a trabajar.

## Selección y jornada

- Solo auditorías completadas en Bloqueantes. La cohorte corresponde a `completed_at` en `America/Bogota`, nunca a la fecha de carga.
- Se toma la última finalización del día por estudio, país e ID externo; se excluyen registros retirados/reemplazados y casos sin alertas.
- Meta: `ceil(auditorías elegibles × porcentaje / 100)`, por defecto 20%.
- Riesgo: 40 puntos para el 20% más rápido del estudio con tiempo medible; hasta 20 por proporción de No aplica, hasta 15 por cantidad de No aplica (máximo a partir de 5) y hasta 25 por volumen de alertas (máximo a partir de 10).
- Toda nueva selección se prioriza por riesgo. El único porcentaje configurable es el total a revisar. Se conservan las auditorías que ya habían sido seleccionadas. No se extrapola su tasa de error al universo.
- La muestra se completa de forma incremental; nunca se retiran selecciones ni asignaciones existentes al cambiar el porcentaje.
- Reparto por carga pendiente de alertas, seguido por cantidad de auditorías, entre analistas activos y disponibles.
- La primera asignación necesita activación de la supervisora. Después se actualiza cada minuto mediante `validaflow-pqr-same-day` en pg_cron y al consultar la operación.
- Todo vence al terminar el mismo día en Colombia. Una revisión tardía conserva su cohorte, aparece vencida y no cuenta como cumplimiento del mismo día.
- Al cambiar de día se cierra una vez la cohorte anterior para capturar las validaciones posteriores al último minuto de cron. Esos casos conservan la fecha anterior y no se asignan automáticamente como trabajo nuevo de hoy.
- El histórico y los pendientes anteriores se consultan con fecha y la opción correspondiente; no se suman a la meta del día siguiente.

## Segunda revisión

Se guarda una copia de las respuestas y evidencias al seleccionar la auditoría. PQR no escribe en `public.audits`.
Cada alerta se evalúa como correcta, incorrecta o no evaluable. Un error exige respuesta correcta y explicación; no evaluable exige explicación.
La auditoría solo puede completarse tras evaluar todas sus alertas. El resultado final se deriva de esas evaluaciones.
Los tiempos de inicio y finalización se registran con el reloj del servidor. Los cambios de versión evitan sobrescribir un borrador desde otra pestaña.
Las revisiones completas quedan en consulta; no se sobrescriben. La supervisora solo puede reasignar casos pendientes sin revisión iniciada.
El CSV tiene una fila por alerta y conserva separadas la respuesta original y la evaluación PQR. Límite visible de 10.000 auditorías por descarga.

## Aislamiento y verificación

- Cliente Supabase con almacenamiento `validaflow-pqr-auth-v1`, separado del portal existente.
- Credenciales y sesiones PQR en tablas `private.pqr_*`, con RLS y sin permisos directos para clientes.
- RPCs públicas `pqr_login` y `pqr_api`: invocadores de funciones privadas con autorización explícita por acción y asignación.
- Supervisión mediante credenciales PQR; analistas mediante código `PQR-` más 12 caracteres aleatorios (60 bits), sin 0, 1, I ni O para facilitar su lectura. Los códigos anteriores siguen siendo válidos hasta que se regeneren. Sesiones de 12 horas, revocables por activación/cambio de credencial.
- Contraseñas bcrypt; autenticación de códigos SHA-256; copia de códigos cifrada en Vault, recuperable solo por supervisión/administración PQR mediante `get_code` y con evento de auditoría sin el código. Eliminar al analista retira también la copia recuperable. Limitación de intentos por identidad y credencial. No hay secretos de servicio en el navegador.
- La cuenta administrativa existente solo inicia la configuración y crea cuentas PQR; no se cambia su perfil.

Instalación idempotente: `supabase/sql/pqr-operation.sql`.
Pruebas locales: `node --test tests/pqr-domain.test.mjs`.
Pruebas reales: `tests/pqr-integration.sql`, que revierte todos los datos simulados dentro de una subtransacción.
Vista sintética para QA: `node tests/pqr-preview.cjs`, puerto 8777.
