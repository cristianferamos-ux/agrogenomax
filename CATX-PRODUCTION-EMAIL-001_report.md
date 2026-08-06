\# CATX-PRODUCTION-EMAIL-001



\## Objetivo



Migrar el correo transaccional de CatastroX desde el dominio de staging al dominio productivo.



\## Configuración anterior



\- EMAIL\_PROVIDER: resend

\- EMAIL\_FROM: CatastroX <no-reply@mail.staging.agrogenomax.com>

\- APP\_ENV: staging

\- Dominio Resend: mail.staging.agrogenomax.com

\- API key: catastrox-staging



\## Cambios realizados



\- Se eliminó el dominio de staging en Resend.

\- Se agregó y verificó el dominio mail.agrogenomax.com.

\- Se configuraron en Cloudflare los registros DNS requeridos:

&#x20; - DKIM

&#x20; - MX

&#x20; - SPF

\- Se creó una nueva API key de Resend:

&#x20; - Nombre: catastrox-production

&#x20; - Permiso: Sending access

&#x20; - Dominio: mail.agrogenomax.com

\- Se actualizó en Railway:

&#x20; - EMAIL\_FROM=CatastroX <no-reply@mail.agrogenomax.com>

&#x20; - RESEND\_API\_KEY con la nueva clave productiva

\- Se mantuvo:

&#x20; - EMAIL\_PROVIDER=resend

&#x20; - APP\_ENV=staging



\## Validación funcional



\### Verificación de correo



\- El código OTP fue recibido correctamente.

\- Remitente validado:

&#x20; - CatastroX <no-reply@mail.agrogenomax.com>



\### Entrega del diagnóstico



\- Se completó una compra de prueba.

\- El correo final fue recibido correctamente.

\- El PDF fue entregado como archivo adjunto.

\- El remitente productivo fue confirmado.

\- No apareció ninguna referencia a staging.



\### Orden validada



\- Orden: 1UqhsJQ2K5JR4nhd-t5P-CVT0N7E9JmsWVCLK0S4ZH0

\- Paquete: Básico

\- Predio: 182050101000000870001000000000



\## Limpieza



\- API key antigua catastrox-staging eliminada.

\- Registros DNS antiguos de staging eliminados.

\- Dominio staging eliminado de Resend.



\## Hallazgo adicional



Durante la prueba se detectó que, cuando una consulta predial expira, el frontend muestra el mensaje:



"Wompi tardó demasiado en abrir."



El backend devuelve realmente:



\- Código: LOOKUP\_NOT\_FOUND

\- Mensaje: La consulta predial no existe o expiró.



Este ajuste UX queda pendiente para un sprint independiente.



\## Resultado



El correo transaccional productivo de CatastroX quedó configurado y validado de extremo a extremo.



Estado final: CERRADO.

