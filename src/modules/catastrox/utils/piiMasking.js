// Enmascarado de PII solo para presentación en pantalla (Bloque 3/10 del
// pedido) -- nunca se usa para decidir nada de seguridad ni se envía al
// backend; el backend nunca recibe ni devuelve estos valores enmascarados,
// solo los originales (o, en el caso de "mis compras", ninguno en absoluto).

export function maskEmail(email) {
  const value = String(email || '').trim();
  const atIndex = value.indexOf('@');
  if (atIndex <= 0) return value ? '***' : '';

  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  const masked = local.length > visible.length ? `${visible}${'*'.repeat(Math.min(local.length - visible.length, 6))}` : visible;
  return `${masked}@${domain}`;
}

export function maskDocumentNumber(documentNumber) {
  const value = String(documentNumber || '').trim();
  if (value.length <= 4) return '*'.repeat(value.length);
  const visible = value.slice(-4);
  return `${'*'.repeat(Math.min(value.length - 4, 8))}${visible}`;
}
