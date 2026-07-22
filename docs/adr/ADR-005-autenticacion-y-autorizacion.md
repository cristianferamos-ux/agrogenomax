# ADR-005: Autenticación y autorización por niveles de ruta, obligatorias antes del paso a producción

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-005 conserva vigente la clasificación por niveles de ruta y la obligación de autenticación/autorización antes de producción. Decisiones posteriores cierran las alternativas que en esta ADR quedaron abiertas:

- ADR-007 seleccionó Amazon Cognito.
- ADR-009 seleccionó BFF Express con sesión referenciada, cookie opaca `HttpOnly`/`Secure`/`SameSite` y CSRF para navegador.
- Integraciones externas autorizadas usan Bearer.
- ADR-008 define organizaciones, membresías, `organizacion_id`, autorización centralizada y RLS.
- ADR-013 gobierna la autorización transaccional pública de CatastroX.
- ADR-011 sustituye App Runner por ECS Express Mode.
- Cognito/BFF/CSRF/RLS siguen pendientes de implementación en el código actual, aunque la decisión arquitectónica ya esté cerrada.

## Contexto

La auditoría técnica clasificó como **Crítico** el hallazgo de que **no existe ningún sistema de autenticación ni autorización en todo el backend** (`server/routes/*.js`): no hay JWT, sesiones, `passport`, `bcrypt` ni control de roles/permisos en ninguna parte del código auditado. Todos los endpoints CRUD (animales, predios, potreros, pesajes, vacunaciones, tratamientos, reproducción, razas, QR) y el endpoint de checkout de pagos (`catastroxPayments.js`) son de acceso público sin control de identidad. Las únicas guardas existentes (`isLocalAuditRequest`, débil por depender de headers falsificables; `isLocalSocketRequest`, robusta pero basada en IP de socket real) protegen únicamente dos endpoints de auditoría/diagnóstico de CatastroX, no la superficie de negocio.

Es relevante para esta decisión que **CatastroX opera hoy como un producto comercial público**: un usuario busca un predio y compra un paquete/reporte a través de Wompi sin necesidad de crear una cuenta ni iniciar sesión. Cualquier decisión de autenticación debe reconocer esta realidad de negocio, no imponer una barrera de login que no existe hoy y que podría romper el flujo comercial de CatastroX sin justificación.

## Problema

Exponer este sistema en un entorno de producción accesible (incluida la migración a AWS) sin ningún control implica que cualquier cliente que conozca las URLs puede leer, crear y modificar datos sin control de identidad alguno. Al mismo tiempo, exigir autenticación de forma indiscriminada en **todas** las rutas rompería el modelo comercial actual de CatastroX, que depende de la compra pública sin registro.

## Opciones consideradas

- **Exigir autenticación uniforme en absolutamente todos los endpoints, incluida la compra pública de CatastroX**: descartada — no refleja el modelo de negocio actual ni es necesaria para mitigar el riesgo real, que está en las operaciones privadas/administrativas, no en la consulta o compra pública en sí.
- **Depender de Supabase Auth**: descartada — el esquema `public`/Supabase queda clasificado como legacy pendiente de retiro (ADR-002); adoptar su mecanismo de Auth reintroduciría precisamente la dependencia que se está retirando.
- **AWS Cognito**: alternativa que quedó pendiente de evaluación al aprobar ADR-005; ADR-007 la seleccionó posteriormente como mecanismo vigente.
- **Autenticación propia (JWT + `passport`/`bcrypt` sobre Express)**: alternativa que quedó pendiente de evaluación al aprobar ADR-005; ADR-007 la descartó como mecanismo principal frente a Cognito.
- **Mantener únicamente las guardas locales actuales** (`isLocalAuditRequest`/`isLocalSocketRequest`) como única protección: descartada explícitamente — ya identificado como el hallazgo Crítico de la auditoría; estas guardas cubren un subconjunto mínimo de rutas de diagnóstico, no la superficie de negocio ni de pagos.

## Decisión

Se establecen **tres niveles diferenciados de ruta**, cada uno con un requisito de control distinto:

1. **Rutas públicas controladas**: operaciones que el negocio requiere que permanezcan accesibles sin login (por ejemplo, la búsqueda predial y la compra de paquetes de CatastroX vía Wompi). **No se exige automáticamente autenticación de usuario para toda compra pública de CatastroX.** En su lugar, toda operación pública transaccional se rige por ADR-013: customer, order, order_item, payment, entitlement, artifact, token de intercambio y cookie de acceso.
2. **Rutas autenticadas**: cualquier operación que exponga información privada de una cuenta, permita descargas privadas, o dependa de una cuenta de usuario (por ejemplo, todo el CRUD de Ganadería: animales, predios, potreros, pesajes, vacunaciones, tratamientos, reproducción, QR) **requiere Cognito/BFF, autorización de negocio centralizada y RLS**, sin excepción.
3. **Rutas administrativas**: endpoints de auditoría, diagnóstico o gestión interna (hoy protegidos parcialmente por `isLocalAuditRequest`/`isLocalSocketRequest`) **requieren autenticación y autorización de rol administrativo**, no solo una guarda de red.
4. **Demo**: no usa backend, Cognito, cookies de servidor, Wompi ni base de datos.

En ADR-005, el mecanismo definitivo de autenticación (AWS Cognito vs. solución propia) quedó históricamente pendiente de evaluación. ADR-007 y ADR-009 cerraron esa decisión: navegador-BFF usa Cognito, sesión referenciada, cookie opaca `HttpOnly`/`Secure`/`SameSite` y CSRF; integraciones externas autorizadas usan Bearer. La obligación bloqueante de implementar autenticación real antes de producción se mantiene, y dicho mecanismo no debe depender de Supabase Auth, dado el retiro de esa dependencia establecido en ADR-002.

## Justificación

- El hallazgo Crítico de la auditoría se refiere a la ausencia total de control, no a la ausencia específica de login para compradores públicos de CatastroX — el riesgo real y prioritario está en el CRUD de Ganadería y en cualquier información/descarga privada, completamente abiertos hoy.
- Forzar login para la compra pública de CatastroX introduciría fricción comercial no solicitada por el negocio y no requerida por el hallazgo de seguridad, que es igualmente resoluble mediante controles transaccionales (firma, límite de tasa, trazabilidad, no reutilización, validación server-side) sin necesidad de una cuenta de usuario.
- Excluir Supabase Auth como opción evita reintroducir por la puerta trasera una dependencia que ADR-002 ya decidió retirar.
- Mantener Cognito y la autenticación propia como alternativas abiertas fue una postura histórica prudente al aprobar ADR-005; ADR-007 cerró la selección en favor de Cognito y ADR-011 actualizó la plataforma backend a ECS Express Mode.

## Consecuencias positivas

- Cierra el hallazgo Crítico de la auditoría en las rutas que realmente lo requieren (CRUD ganadero, información/descargas privadas, administración) sin romper el modelo comercial público de CatastroX.
- Sienta las bases para un modelo de roles/permisos formal, hoy inexistente, diferenciado por nivel de sensibilidad de la ruta.
- Endurece la seguridad de las operaciones transaccionales públicas (pagos) sin imponer una barrera de registro no solicitada.

## Consecuencias negativas

- Añade alcance y tiempo de desarrollo antes de poder considerar el sistema listo para producción, tanto para el mecanismo de autenticación como para los controles transaccionales de las rutas públicas.
- Requiere retrofitting de autenticación en todos los endpoints hoy abiertos que caigan en el nivel "autenticado" o "administrativo", con el consiguiente trabajo de pruebas y coordinación con el frontend.
- La lógica de "operación pública transaccional segura" queda especificada por ADR-013 y sigue siendo una pieza de diseño e implementación no trivial, distinta de simplemente añadir un middleware de login.

## Riesgos

- Clasificar incorrectamente una ruta (por ejemplo, tratar como "pública controlada" algo que en realidad expone información privada) reintroduciría el riesgo original — la clasificación de cada endpoint en uno de los tres niveles debe revisarse con cuidado, ruta por ruta.
- Si el retrofitting no se coordina cuidadosamente con el frontend, se puede romper la integración actual (llamadas que hoy funcionan sin credenciales dejarían de responder en las rutas que pasen a requerir autenticación).
- La guarda `isLocalSocketRequest`, aunque robusta hoy, deberá revisarse en conjunto con Cognito/BFF, autorización administrativa y la topología final de red en ECS/ALB (ver ADR-001 y ADR-011).
- Postergar la implementación de Cognito/BFF/CSRF/RLS, aunque la decisión ya esté cerrada, retrasa el cierre operativo de esta ADR.

## Acciones requeridas

- Clasificar explícitamente, ruta por ruta, cada endpoint existente en uno de los tres niveles (pública controlada / autenticada / administrativa).
- Implementar el mecanismo definitivo ya decidido: Amazon Cognito + BFF Express + cookie opaca + CSRF para navegador, y Bearer solo para integraciones externas autorizadas.
- Diseñar e implementar organizaciones, membresías, `organizacion_id`, autorización centralizada y RLS conforme a ADR-008.
- Diseñar e implementar los controles de operación pública transaccional seguros para el flujo de pagos de CatastroX conforme a ADR-013, reemplazando la ausencia actual de control.
- Instrumentar middleware de autenticación/autorización en `server/index.js` y en cada router afectado, según la clasificación de nivel.
- Escribir pruebas automatizadas de autorización (hoy inexistentes para cualquier ruta de negocio) y de los nuevos controles transaccionales públicos.
- Revisar y, si corresponde, reemplazar `isLocalAuditRequest`/`isLocalSocketRequest` en función del mecanismo elegido para rutas administrativas.

## Criterios de aceptación

- Todo el CRUD ganadero, la información privada de cuentas, las descargas privadas y las rutas administrativas exigen autenticación (y, en el caso administrativo, autorización de rol) sin excepción.
- Las operaciones públicas transaccionales de CatastroX (incluido el checkout de pagos) **no requieren login de usuario**, pero sí cumplen ADR-013 con order, payment, entitlement, artifact, token de intercambio y cookie de acceso.
- Existe un modelo de organizaciones, membresías, roles/permisos, autorización centralizada y RLS aplicado de forma consistente en las rutas autenticadas y administrativas.
- El paso a producción (incluida la migración a AWS) queda formalmente bloqueado hasta el cumplimiento de esta ADR en los tres niveles de ruta.

## Elementos fuera de alcance

- Selección final del proveedor/mecanismo de autenticación: ya resuelta por ADR-007 y ADR-009; queda fuera de alcance de este ADR duplicar su especificación.
- Implementación de código (esta ADR es una decisión de arquitectura, no una tarea de desarrollo).
- Cambios a las interfaces congeladas de Home, Ganadería o CatastroX.
