// Facturación electrónica (Bloque 11 del pedido) -- interfaz preparada,
// SIN proveedor conectado. No existe en este repo ninguna integración con
// un proveedor de facturación electrónica colombiano -- conectar una
// requeriría credenciales que CRH todavía no ha provisto, y esta tarea no
// debe inventarlas ni simular una factura.
import { query } from '../../db.js';

const INVOICE_JOBS_TABLE = 'public.catastrox_invoice_jobs';

/**
 * Registra únicamente la intención de facturar (NOT_REQUESTED) al aprobar
 * una orden -- no intenta emitir nada todavía. createElectronicInvoiceForOrder()
 * es la interfaz que un flujo posterior (soporte, o un trabajo periódico
 * una vez exista proveedor) invocaría explícitamente.
 *
 * EXACTAMENTE una fila por payment_order_id (UNIQUE, migración 005) --
 * una segunda llamada para la misma orden es un no-op que devuelve la fila
 * ya existente, nunca duplica el trabajo de facturación de una orden.
 */
export async function createInvoiceJobForOrder(orderId, client = null) {
  const runner = client || { query };
  const result = await runner.query(
    `insert into ${INVOICE_JOBS_TABLE} (payment_order_id, status) values ($1, 'NOT_REQUESTED')
     on conflict (payment_order_id) do update set status = ${INVOICE_JOBS_TABLE}.status
     returning *`,
    [orderId],
  );
  return result.rows[0];
}

/**
 * Interfaz real de emisión de factura electrónica para una orden ya
 * aprobada. Recibe EXCLUSIVAMENTE `orderId` -- toda la información
 * (comprador, perfil de facturación, paquete, valor, moneda, pago
 * verificado) se lee desde backend (la orden y su catastrox_billing_profiles),
 * nunca de parámetros que pudieran venir de un frontend. Sin proveedor
 * conectado: lanza explícitamente, deja constancia en FAILED con un código
 * saneado -- nunca simula un número de factura.
 *
 * @param {string} orderId
 * @returns {Promise<never>}
 */
export async function createElectronicInvoiceForOrder(orderId) {
  const result = await query(
    `select po.id, po.status, po.package_id, po.expected_amount_in_cents, po.currency, bp.id as billing_profile_id,
            ij.status as invoice_job_status
       from public.catastrox_payment_orders po
       left join public.catastrox_billing_profiles bp on bp.payment_order_id = po.id
       left join public.catastrox_invoice_jobs ij on ij.payment_order_id = po.id
      where po.id = $1`,
    [orderId],
  );
  const order = result.rows[0];

  if (!order) {
    const error = new Error('Orden no encontrada.');
    error.code = 'INVOICE_ORDER_NOT_FOUND';
    throw error;
  }
  if (order.status !== 'APPROVED') {
    const error = new Error('Solo se factura una orden con pago aprobado.');
    error.code = 'INVOICE_ORDER_NOT_APPROVED';
    throw error;
  }
  if (!order.billing_profile_id) {
    const error = new Error('La orden no tiene un perfil de facturación asociado.');
    error.code = 'INVOICE_BILLING_PROFILE_MISSING';
    throw error;
  }
  // Defecto corregido (revisión de seguridad): una factura ya ISSUED nunca
  // debe volver a FAILED/PENDING por un reintento posterior -- se rechaza
  // explícitamente ANTES de tocar ninguna fila, sin excepción.
  if (order.invoice_job_status === 'ISSUED') {
    const error = new Error('La factura de esta orden ya fue emitida -- no se vuelve a emitir.');
    error.code = 'INVOICE_ALREADY_ISSUED';
    throw error;
  }

  await query(
    `update public.catastrox_invoice_jobs
        set status = 'FAILED', attempt_count = attempt_count + 1, last_error_code = $2, updated_at = now()
      where payment_order_id = $1`,
    [orderId, 'ELECTRONIC_INVOICE_PROVIDER_NOT_CONFIGURED'],
  );
  await query(
    `update public.catastrox_billing_profiles
        set billing_status = 'FAILED', electronic_invoice_error_code = $2, updated_at = now()
      where payment_order_id = $1`,
    [orderId, 'ELECTRONIC_INVOICE_PROVIDER_NOT_CONFIGURED'],
  );

  const error = new Error('No hay un proveedor de facturación electrónica configurado todavía.');
  error.code = 'ELECTRONIC_INVOICE_PROVIDER_NOT_CONFIGURED';
  throw error;
}
