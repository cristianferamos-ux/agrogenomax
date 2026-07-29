// Interfaz de envío de correo (Bloque 5/9 del pedido) -- NO hay proveedor
// real conectado en este repo (sin SMTP/SES/Resend configurado). Esta es
// la interfaz que un proveedor real implementaría; hoy solo registra el
// intento (sin PII completa) y devuelve `delivered:false, mode:'stub'`
// explícitamente -- nunca finge un envío exitoso.
//
// Contrato de retorno estable (revisión de seguridad): el llamador
// (server/routes/catastroxPayments.js) decide el mensaje/estado HTTP a
// partir de `delivered`/`mode`, nunca asume éxito por defecto. Cuando se
// conecte un proveedor real, esta función debe devolver
// `{ delivered: true, providerMessageId, mode: 'provider' }` únicamente
// si el proveedor confirmó la entrega -- nunca marcar delivered:true de
// forma optimista.
//
// @returns {Promise<{ delivered: boolean, providerMessageId: string|null, mode: 'stub'|'provider' }>}
export async function sendEmail({ to, subject }) {
  const domain = String(to || '').split('@')[1] || null;
  console.info('[CatastroX Email] (sin proveedor conectado) intento de envío registrado', {
    toDomain: domain,
    subject,
  });

  return { delivered: false, providerMessageId: null, mode: 'stub' };
}
