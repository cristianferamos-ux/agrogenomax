// FASE 1B / FASE 5A.2: historial de pesajes, más reciente primero (la
// respuesta de la API es ascendente; solo se invierte una copia para
// presentar). En pantallas estrechas cada fila se muestra como tarjeta (ver
// ganaderia-hato.css: cada celda lleva su etiqueta en data-label).
//
// FASE 5A.2: muestra `historial` (ACTIVOS + ANULADOS). Un ANULADO conserva su
// fecha y peso originales, con el estado "Anulado", su motivo y la fecha de
// anulación, sin derivaciones; una medición previa del mismo día explica por
// qué no tiene GMD. Nunca se muestran actor, clientOperationId ni ids
// internos. "Anular" solo aparece si la ficha lo permite (accionAnularPesaje);
// sin conexión se explica que la anulación requiere red.
//
// DEUDA (accesibilidad, no bloqueante): la celda colSpan=3 "Cálculo" sustituye
// Diferencia / Días / GMD en filas sin derivaciones; un lector de pantalla
// anuncia "Cálculo" en vez de las tres columnas. Ver
// docs/ganaderia/FASE-5A-integridad-pesajes-diseno.md (deuda menor).
import {
  formatDiferenciaKg,
  formatDias,
  formatFecha,
  formatGmd,
  formatKg,
  formatMetodo,
  historialParaVista,
} from './pesajesModel.js';
import { accionAnularPesaje, presentarFilaHistorial } from './pesajesAnulacionModel.js';

export default function HatoPesajesHistorial({ pesajes, puedeAnular = false, admitePesajes = true, online = true, ocupado = false, onAnular }) {
  const filas = historialParaVista(pesajes).map((p) => ({
    p,
    vista: presentarFilaHistorial(p),
    accion: accionAnularPesaje({ puedeAnular, pesaje: p, admitePesajes, online }),
  }));
  const conAcciones = filas.some((f) => f.accion.visible);
  const anulados = filas.filter((f) => f.vista.estado === 'ANULADO').length;
  return (
    <div className="gan-pesajes-historial">
      <table>
        <caption>Historial de pesajes (más reciente primero)</caption>
        <thead>
          <tr>
            <th scope="col">Fecha</th>
            <th scope="col">Peso</th>
            <th scope="col">Método</th>
            <th scope="col">Estado</th>
            <th scope="col">Diferencia</th>
            <th scope="col">Días</th>
            <th scope="col">GMD</th>
            <th scope="col">Observaciones</th>
            {conAcciones ? <th scope="col"><span className="gan-sr-only">Acciones</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {filas.map(({ p, vista, accion }) => (
            <tr key={p.pesajeId} className={vista.estado === 'ANULADO' ? 'gan-pesaje-fila is-anulado' : 'gan-pesaje-fila'} data-estado={vista.estado}>
              <td data-label="Fecha">{formatFecha(p.fecha)}</td>
              <td data-label="Peso">{formatKg(p.pesoKg)}</td>
              <td data-label="Método">{formatMetodo(p.metodo)}</td>
              <td data-label="Estado">
                <span className={`gan-repro-badge ${vista.estado === 'ANULADO' ? 'gan-repro-badge-anulado' : 'gan-repro-badge-activo'}`}>{vista.etiquetaEstado}</span>
              </td>
              {vista.sinDerivaciones ? (
                <td data-label="Cálculo" colSpan={3} className="gan-pesaje-nota-calculo">{vista.notaCalculo}</td>
              ) : (
                <>
                  <td data-label="Diferencia">{formatDiferenciaKg(p.diferenciaKg)}</td>
                  <td data-label="Días">{formatDias(p.diasDesdeAnterior)}</td>
                  <td data-label="GMD">
                    {formatGmd(p.gmdKgDia)}
                    {vista.notaMismoDia ? <span className="gan-hato-hint gan-pesaje-nota-mismo-dia">{vista.notaMismoDia}</span> : null}
                  </td>
                </>
              )}
              <td data-label="Observaciones">{p.observaciones || '—'}</td>
              {conAcciones ? (
                <td data-label="Acciones">
                  {accion.visible ? (
                    <button
                      type="button"
                      className="gan-secondary-button gan-pesaje-anular"
                      onClick={() => onAnular?.(p)}
                      disabled={!accion.habilitado || ocupado}
                      title={accion.motivoBloqueo ?? undefined}
                    >
                      Anular
                    </button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {anulados ? (
        <p className="gan-hato-hint">
          {anulados === 1 ? '1 pesaje anulado' : `${anulados} pesajes anulados`}: se conservan como registro y no participan en los cálculos productivos.
        </p>
      ) : null}
    </div>
  );
}
