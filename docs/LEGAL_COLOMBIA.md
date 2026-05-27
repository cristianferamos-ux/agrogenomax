# AgroGenomaX - documentos legales base Colombia

Este documento es una base operativa para revision juridica antes de produccion.

## Politica de privacidad

AgroGenomaX recolecta y trata datos personales de usuarios, propietarios, empleados, veterinarios, consultores y operadores para prestar servicios de gestion ganadera, trazabilidad animal, analitica productiva, soporte tecnico, seguridad, auditoria y cumplimiento contractual.

Datos tratados:
- Identificacion y contacto.
- Credenciales de acceso gestionadas por Supabase Auth.
- Actividad dentro de la plataforma.
- Datos asociados a predios, animales, eventos sanitarios, productivos y reproductivos.
- Archivos cargados por usuarios autorizados.

Finalidades:
- Operar la plataforma SaaS.
- Administrar empresas, fincas, animales y usuarios.
- Generar QR, reportes, alertas, indicadores y auditorias.
- Cumplir obligaciones legales, contractuales y de seguridad.

## Politica de tratamiento de datos personales

El titular puede conocer, actualizar, rectificar y solicitar supresion de sus datos conforme a la Ley 1581 de 2012 y normas concordantes. La atencion de solicitudes debe canalizarse por el correo oficial definido por AgroGenomaX.

Medidas:
- HTTPS obligatorio.
- Autenticacion JWT.
- RLS por tenant.
- Auditoria de operaciones criticas.
- Control de roles.
- Almacenamiento privado de archivos.

## Consentimiento Habeas Data

Texto recomendado para registro:

"Autorizo de manera previa, expresa e informada a AgroGenomaX para recolectar, almacenar, usar, circular, procesar y suprimir mis datos personales conforme a la politica de tratamiento de datos, con la finalidad de operar la plataforma, prestar servicios contratados, administrar usuarios, fincas, animales, trazabilidad, reportes, soporte, seguridad y cumplimiento legal."

El sistema debe guardar:
- `habeas_data_accepted = true`
- `habeas_data_accepted_at`
- `privacy_accepted_at`
- version de documentos aceptados

## Terminos y condiciones

AgroGenomaX es una plataforma SaaS para gestion ganadera, trazabilidad, reproduccion, sanidad, produccion, analitica y soporte de decisiones. La informacion registrada por cada cliente pertenece a su organizacion. El cliente es responsable por la veracidad de datos ingresados, autorizaciones de usuarios y uso operativo de la informacion.

Restricciones:
- No compartir credenciales.
- No acceder a datos de terceros.
- No cargar informacion ilegal o no autorizada.
- No usar la plataforma para decisiones veterinarias sin criterio profesional competente.

## Nota juridica

Este archivo no reemplaza asesoria legal. Antes de operar comercialmente, debe revisarse por abogado en proteccion de datos en Colombia.
