---
name: crh-token-saver
description: Usar para tareas de CRH, AgroGenomaX, CatastroX, AWS, frontend, backend, base de datos, depuración y despliegue cuando se requiera minimizar consumo de tokens.
---

# CRH Token Saver

## Objetivo

Ejecutar tareas técnicas usando el menor número razonable de tokens, sin perder precisión, seguridad ni trazabilidad.

## Reglas obligatorias

- Responder siempre en español.
- Ser breve, claro y operativo.
- No repetir contexto ya conocido.
- No explicar teoría salvo que el usuario la pida.
- No leer archivos completos si basta con búsqueda dirigida.
- No imprimir logs extensos.
- No mostrar archivos completos si solo cambian fragmentos.
- No tocar secretos, claves, tokens, contraseñas ni archivos `.env`.
- Antes de eliminar, sobrescribir, publicar o exponer algo, pedir confirmación.
- Priorizar cambios mínimos y verificables.

## Método de trabajo

1. Identificar el objetivo exacto.
2. Buscar archivos relevantes con comandos dirigidos.
3. Leer solo fragmentos necesarios.
4. Modificar la menor cantidad posible de archivos.
5. Verificar con comando concreto.
6. Reportar solo cambios, verificación y siguiente paso.

## Comandos preferidos

Usar búsquedas y salidas compactas:

- rg "texto_o_funcion" src server
- git status --short
- git diff --stat
- git diff -- nombre-del-archivo
- npm run build 2>&1 | Select-Object -Last 80

## Formato de respuesta

Después de ejecutar una tarea, responder así:

Hecho.

Cambios:
- ...

Verificación:
- ...

Siguiente paso:
- ...

Si hay error:

Bloqueo encontrado.

Error relevante:
- ...

Causa probable:
- ...

Acción recomendada:
- ...

## Reglas AWS

- Priorizar seguridad, bajo costo y simplicidad.
- No crear recursos innecesarios.
- No sugerir servicios costosos si existe alternativa inicial más simple.
- Confirmar antes de generar costos, exponer servicios públicos o eliminar recursos.
- Priorizar MFA, IAM Identity Center, presupuestos, alertas y control de costos.
- Para AgroGenomaX, AWS será la infraestructura oficial.

## Reglas frontend

- Ubicar componente y CSS antes de modificar.
- No rediseñar toda la pantalla salvo orden expresa.
- Mantener identidad visual aprobada.
- Reportar cambios visuales en máximo 5 puntos.

## Reglas backend

- Identificar ruta, controlador, servicio y variables necesarias.
- No imprimir `.env`.
- No cambiar contratos API sin advertir.
- Verificar endpoint con prueba mínima.

## Reglas base de datos

- Validar conexión antes de cargar datos.
- Usar conteos, muestras pequeñas y metadatos.
- No imprimir tablas completas.
- Para datos grandes, trabajar por capa, departamento, municipio o lote.

## Estilo para el usuario

El usuario prefiere respuestas:
- limpias,
- separadas,
- paso a paso,
- sin bloques largos,
- enfocadas en ejecución.
