# ADR-001: Arquitectura AWS inicial — decisión histórica de App Runner, sustituida parcialmente por ADR-011

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-001 conserva valor histórico y sigue vigente en su intención de migrar AgroGenomaX hacia AWS de forma incremental, reversible y controlada. Sin embargo, decisiones posteriores precisan o sustituyen partes de esta ADR:

- ADR-011 sustituye únicamente la selección original de App Runner. La plataforma vigente es Amazon ECS Express Mode.
- ECS + Fargate directo mediante Terraform es la contingencia AWS si ECS Express Mode no resulta aplicable.
- Railway permanece como rollback temporal hasta completar y aprobar los gates de migración.
- ADR-010 sustituye cualquier tratamiento incompleto de infraestructura como código, state, locking, KMS, CI y bootstraps.
- ADR-012 gobierna health, liveness, readiness y graceful shutdown.
- ADR-014 gobierna la separación demo/staging/producción.
- Conservan vigencia de ADR-001: AWS como plataforma objetivo, migración incremental y reversible, Cloudflare para frontend/DNS/CDN/relay, RDS como destino de datos condicionado por ADR-006/ADR-008, no big bang, control presupuestal y rollback.

## Contexto

La auditoría técnica confirmó que la infraestructura de producción actual es Cloudflare Pages (frontend estático) + Cloudflare Pages Functions (proxy) + backend Express desplegado en Railway (`agrogenomax-production.up.railway.app`, hardcodeado en `functions/_data/agxStatic.js`). No existía ningún recurso de AWS creado todavía; la evidencia de intención hacia AWS era documental (`CLAUDE.md:21`, `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`). En ese estado histórico, el plan heredado mencionaba backend en AWS App Runner, ECS Fargate descartado "por ahora", frontend evaluado en AWS Amplify Hosting como posibilidad futura, corte por etapas y presupuesto tope de USD 25/mes en staging. Esas selecciones de plataforma y costos fueron actualizadas posteriormente por ADR-010, ADR-011, ADR-012 y ADR-014.

## Problema

Se necesita definir el destino de infraestructura inicial en AWS para el backend Express y las dos bases de datos, sin interrumpir la operación actual en Cloudflare/Railway, sin migrar el frontend todavía, y sin superar el presupuesto aprobado de la fase de staging.

## Opciones consideradas

- **EC2** (gestión manual de instancias): descartada por mayor carga operativa (parcheo, escalado manual, sin gestión nativa de despliegues).
- **ECS Fargate**: descartada históricamente en el plan inicial ("por ahora"); ADR-011 la reubica como contingencia AWS mediante ECS + Fargate directo con Terraform.
- **AWS Lambda**: no evaluada en profundidad — el backend mantiene pools persistentes de conexión PostgreSQL (`server/db.js`, `server/catastroxDb.js`) y estado en memoria (búfer de telemetría del modo sombra de CatastroX), patrones poco compatibles con la naturaleza efímera de Lambda sin rediseño.
- **AWS App Runner** (elegida históricamente): menor carga operativa que EC2/Fargate, despliegue directo desde imagen o repositorio, facturación por uso. Esta elección fue sustituida por ADR-011 y no está autorizada como plataforma vigente.
- **Mantener Railway indefinidamente**: descartada como destino final — contradice la intención declarada de que "AWS será la infraestructura oficial de AgroGenomaX" (`CLAUDE.md:21`); se conserva únicamente como mecanismo temporal de rollback (ver Decisión).

## Decisión

La migración a AWS sigue esta secuencia ordenada, sin saltar pasos:

1. **Cloudflare mantiene frontend, DNS y CDN.** No se migra el frontend a Amplify ni se cambia ningún registro DNS en esta fase. El frontend **no** forma parte de esta secuencia de corte.
2. **Se crea un entorno de staging en AWS sin afectar producción.** Cloudflare Pages, Railway, DNS y las bases de datos reales no registran ningún cambio durante esta etapa (checklist ya exigido por el plan aprobado).
3. **Decisión histórica original:** el backend Express migraba a AWS App Runner. **Estado vigente:** esta selección fue sustituida por ADR-011; la plataforma autorizada es Amazon ECS Express Mode, con ECS + Fargate directo como contingencia AWS.
4. **Ganadería migra a Amazon RDS PostgreSQL**, usando el dominio lógico `agx` como fuente canónica, condicionado por ADR-002 y por el modelo multicliente/RLS de ADR-008.
5. **CatastroX migra a Amazon RDS PostgreSQL con PostGIS únicamente cuando su proceso de datos geoespaciales sea reproducible**, condición establecida en ADR-006. Hasta entonces, CatastroX permanece en su infraestructura actual.
6. **Railway se conserva temporalmente como mecanismo de rollback** durante la transición del backend a AWS, hasta que la operación quede validada de forma estable.

## Justificación

- La elección original de App Runner reflejaba el menor costo operativo percibido en el momento de aprobar ADR-001; ADR-011 sustituyó esa plataforma por Amazon ECS Express Mode sin cambiar la intención de migración incremental.
- Mantener el frontend en Cloudflare durante toda esta secuencia reduce el radio de cambio simultáneo: el corte se limita al backend y a las bases de datos, en ese orden, nunca al frontend en esta fase.
- Migrar el backend antes que las bases de datos, y Ganadería antes que CatastroX, permite validar cada etapa de forma aislada y revertir (vía Railway) si algo falla, en vez de un corte simultáneo de todo el sistema.
- Condicionar la migración de CatastroX a la reproducibilidad de sus datos geoespaciales (ADR-006) evita trasladar infraestructura no documentada a producción.

## Consecuencias positivas

- La decisión histórica buscaba menor carga operativa que EC2/Fargate para el backend; la plataforma vigente tras ADR-011 es ECS Express Mode.
- Ruta de migración incremental, ordenada y reversible (Railway como rollback explícito, Cloudflare sin tocar en esta fase).
- Preserva el aislamiento actual entre las dos bases de datos y permite que Ganadería avance sin esperar a CatastroX.

## Consecuencias negativas

- La dependencia de las limitaciones propias de App Runner queda como consecuencia histórica de la decisión original; no aplica como plataforma vigente después de ADR-011.
- Doble infraestructura de borde durante toda la fase de transición (Cloudflare para frontend, AWS para backend) añade complejidad de configuración de CORS/proxy entre ambos.
- Mantener Railway como rollback implica un costo/operación duplicada mientras dure la transición.

## Riesgos

- **El presupuesto de USD 25/mes es un límite operativo de la fase de staging (recursos encendidos por ventanas de prueba acotadas), no una garantía de costo mensual para un despliegue permanente en AWS.** La estimación histórica de USD 40–80/mes derivada del escenario App Runner + dos instancias RDS queda invalidada para la arquitectura vigente y debe reemplazarse por un recálculo con AWS Pricing Calculator antes de cualquier `apply`.
- Sobrecosto si los recursos de staging quedan encendidos fuera de la ventana de prueba definida.
- Errores de "cableado cruzado" (backend de staging apuntando a base de datos o llaves de Wompi de producción) si las variables de entorno no se revisan manualmente antes del primer despliegue.
- Los pools `pg` actuales no configuran `ssl` (`server/db.js:11-13`, `server/catastroxDb.js:16-20`) — sin corrección, las conexiones a RDS pueden fallar o, en el peor caso, viajar sin cifrar si el proveedor lo permitiera.
- La guarda `isLocalSocketRequest` (`server/routes/catastrox.js:92-95`) debe revisarse frente a la topología vigente de proxy/ALB/ECS y configuración `trust proxy`; no se asume resuelta por la migración.

## Acciones requeridas

- Agregar configuración `ssl` a los pools de `server/db.js` y `server/catastroxDb.js` antes de apuntar a RDS (fuera del alcance de este documento, requiere una tarea de implementación posterior).
- Definir topología de red, ALB/proxy y `trust proxy`, y cómo eso afecta a `isLocalSocketRequest`.
- Diseñar el rol/política IAM mínimo (ya contemplado como actividad de Fase 0A sin costo en el plan aprobado).
- Mapear variables de entorno del backend en ECS/Secrets Manager sin renombrar las que ya consume el código.
- Implementar los contratos de ADR-012: health público mínimo, liveness para ALB, readiness restringida, `Cache-Control: no-store`, graceful shutdown y cierre de pools sin exponer información sensible.
- **Producir una estimación de costos escrita antes de cada `terraform apply`** (staging o, eventualmente, producción), comparándola explícitamente contra el límite vigente en ese momento (USD 25/mes en staging; un tope distinto y formalmente aprobado para producción).

## Criterios de aceptación

- Un backend de staging en Amazon ECS Express Mode queda operativo usando variables de entorno documentadas, sin cambios de código en la lógica de negocio.
- **Existen contratos de health alineados con ADR-012**, distinguiendo `/api/health`, `/api/health/live` y readiness restringida, sin revelar información sensible.
- Las dos instancias RDS de staging permanecen lógicamente separadas (ninguna consulta cruza de una base a la otra).
- Cloudflare Pages y Railway no muestran ningún cambio de configuración durante esta fase (verificación manual, ya exigida por el checklist del plan aprobado).
- Ningún recurso de AWS queda facturando fuera de la ventana de prueba anunciada.
- Existe una estimación de costos documentada y revisada antes de cada `terraform apply`, sin excepción.

## Elementos fuera de alcance

- Corte de DNS de `agrogenomax.com` o migración del frontend fuera de Cloudflare.
- Migración real de datos de producción (solo se valida el método).
- Llaves de producción de Wompi.
- Decisión de autenticación/autorización (ver ADR-005).
- Estrategia de IaC (ver ADR-003).
- Estimación y aprobación formal de un presupuesto de producción permanente (distinto del presupuesto de staging cubierto por esta ADR).
