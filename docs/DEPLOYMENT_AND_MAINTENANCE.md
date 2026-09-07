# Despliegue y mantenimiento

## 1. Entornos y secretos

El código del navegador contiene únicamente la URL del proyecto Supabase y una clave publicable. Es correcto que esa clave esté disponible para el navegador: RLS debe seguir protegiendo cada tabla.

| Ubicación | Puede contener | No debe contener |
| --- | --- | --- |
| `js/supabase-config.js` | URL de Supabase y publishable key | `service_role`, contraseñas o tokens privados |
| Variables de la Edge Function | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Valores impresos en logs o enviados al navegador |
| GitHub Pages | Archivos estáticos públicos | Configuración secreta |

## 2. Aplicar una migración

1. Cree un archivo nuevo en `supabase/migrations/` con prefijo de fecha y hora creciente.
2. Escriba una migración idempotente cuando sea posible (`if not exists`, `drop ... if exists`).
3. Revise políticas RLS, índices, restricciones y compatibilidad con registros existentes.
4. Aplique el SQL en el proyecto Supabase de prueba y verifique la operación afectada.
5. Aplique la misma migración en producción desde la herramienta aprobada de Supabase.
6. Si se añadió una columna que usa un import, vuelva a subir el export del mes para poblarla.
7. Documente el cambio de columnas o proceso en `docs/DATA_DICTIONARY.md`.

Las migraciones existentes son acumulativas y deben aplicarse en orden cronológico. No modifique una migración que ya fue aplicada en producción; agregue una nueva.

## 3. Desplegar la Edge Function

La función ubicada en `supabase/functions/manage-supervisors/index.ts` usa TypeScript/Deno y requiere las variables de entorno configuradas en el proyecto Supabase.

Antes de promover cambios, pruebe:

- creación de un usuario de Operaciones;
- asignación de uno y de ambos módulos;
- reasignación de un usuario existente;
- restablecimiento de contraseña;
- rechazo de una llamada realizada por una persona que no sea administradora.

Una respuesta `401`, `403` o `ADMIN_REQUIRED` indica que falló el control de sesión o de rol, no una validación del formulario del navegador.

## 4. Publicar el frontend

1. Verifique los cambios de HTML, CSS o JavaScript localmente con un servidor HTTP.
2. Revise que no haya claves privadas ni archivos de export con datos sensibles dentro del commit.
3. Envíe los cambios a la rama publicada por GitHub Pages.
4. Espere a que termine el despliegue de Pages y pruebe la URL pública en una ventana privada.

El proyecto usa parámetros de versión (`?v=...`) para los módulos y CSS. Cuando se modifica un recurso que pueda quedarse en caché, incremente su versión en el import o enlace correspondiente de `index.html`/`app.js`. No cambie una versión por estética: es el mecanismo que fuerza la actualización de los navegadores.

## 5. Verificación mínima antes de publicar

- La página abre sin errores de consola.
- Inicio de sesión de un rol administrativo o de pruebas funciona.
- El validador solo ve casos que le fueron asignados.
- La decisión Aplica/No aplica exige una tipología válida.
- Una carga de cada tipo de export muestra el mes, el nombre del archivo y el conteo de registros.
- Los filtros cambian las tarjetas y la tabla, y la descarga respeta el filtro.
- Cambio de nota muestra `No alertó` cuando no existe alerta bloqueante asociada.
- La página de Visualizaciones puede mostrar datos cacheados y luego actualizarse.

## 6. Diagnóstico de cargas

### El archivo parece cargado, pero no muestra registros

1. Verifique el mes de referencia: la vista filtra por el mes elegido.
2. Confirme en el listado de bases cargadas que aparezcan nombre, fecha y cantidad de registros.
3. Confirme que los encabezados estén reconocidos en el [diccionario de datos](DATA_DICTIONARY.md).
4. Revise el rol: los usuarios Comerciales no pueden consultar los imports operativos.
5. En Supabase, revise si RLS permite leer las tablas `admin_*` para ese rol.

### El cruce devuelve cero coincidencias

1. Compare una muestra de ID de auditoría/PDV en ambos archivos.
2. Verifique que no haya ceros, prefijos, espacios o decimales no esperados.
3. Para Export general, las filas cuyo ID no es numérico se descartan deliberadamente.
4. Compruebe que el export de alertas y el de notas/ediciones correspondan al mismo periodo y estudio.

### La vista tarda en abrir

1. La primera apertura de un usuario/equipo descarga el contenido desde Supabase y puede tardar con archivos muy grandes.
2. En las siguientes aperturas debe aparecer primero la copia local de IndexedDB.
3. Use **Actualizar** solo cuando se hayan subido datos nuevos o se necesite forzar la lectura remota.
4. Si el rendimiento se degrada, mida el volumen por tabla, el tiempo de RPC y los índices de los campos de cruce antes de aumentar la concurrencia.

## 7. Respaldo y recuperación

- Mantenga los tres exports fuente de Power BI por mes en una ubicación corporativa con control de versiones.
- Antes de actualizar una carga mensual, descargue o archive el archivo que se está reemplazando.
- Haga respaldos periódicos de las tablas operativas y de los registros normalizados de análisis.
- Para recuperar un mes, vuelva a cargar el archivo fuente correcto; el portal sustituirá la versión normalizada de ese periodo sin afectar los demás meses.
- No ejecute funciones de purga sin una instrucción explícita y una copia verificable de la base de datos.

