# Validadores compartidos entre estudios

`validator-study-memberships.sql` incorpora un registro de pertenencia por
validador, estudio y país. Se aplica antes de publicar `app.js?v=103.0` y
`supabase-backend.js?v=53.0`. Es transaccional y repetible; no elimina usuarios ni
auditorías. Se conserva la identidad original y su código único.

El script está versionado aquí porque el CLI de Supabase no está disponible en
el entorno de esta actualización. Se aplicó desde el editor SQL del proyecto
`jujndhavotibflcredrx` con la sesión de reporting. No es una migración registrada
automáticamente en el historial del CLI.

## Comportamiento

- «Agregar Validador» permite crear uno nuevo o añadir uno activo de otro estudio.
- La lista de candidatos entrega únicamente identificador, nombre y estudio de
  origen; no expone códigos de acceso ni correos de otros estudios.
- Cada operación verifica la sesión y el permiso del supervisor sobre el destino.
- La pertenencia es por estudio/país, compartida por Smart y Bloqueantes, como la
  disponibilidad anterior de los validadores.
- La activación es independiente por estudio. La cuenta permanece activa si
  tiene al menos una pertenencia activa; el inicio de sesión mantiene su código.
- Añadir a un estudio no cambia las auditorías. La repartición y la reasignación
  siguen siendo acciones explícitas del supervisor.
- El frontend no vuelve a escribir la identidad original al guardar auditorías.

## Verificación

`node --test tests/validator-memberships.test.cjs` prueba el adaptador del cliente.
`test-validator-study-memberships.sql` comprueba RLS, permisos, código estable,
prevención de duplicados, activación independiente y reasignación. Sus datos de
prueba y cambios se revierten al terminar mediante `ROLLBACK`.

Se verificó el formulario en navegador con un backend simulado y la integración
SQL con el rol `authenticated`. La revisión de seguridad del proyecto mostró
cero errores y 29 advertencias sobre funciones existentes; no se alteraron sus
contratos de autenticación para resolver avisos ajenos a esta funcionalidad.
