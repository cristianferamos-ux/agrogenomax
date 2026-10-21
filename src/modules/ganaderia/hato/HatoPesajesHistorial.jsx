// FASE 1B: historial de pesajes, más reciente primero (la respuesta de la API
// es ascendente; solo se invierte una copia para presentar). En pantallas
// estrechas cada fila se muestra como tarjeta (ver ganaderia-hato.css: cada
// celda lleva su etiqueta en data-label).
import {
  formatDiferenciaKg,
  formatDias,
  formatFecha,
  formatGmd,
  formatKg,
  formatMetodo,
  historialParaVista,
} from './pesajesModel.js';

export default function HatoPesajesHistorial({ pesajes }) {
  const filas = historialParaVista(pesajes);
  return (
    <div className="gan-pesajes-historial">
      <table>
        <caption>Historial de pesajes (más reciente primero)</caption>
        <thead>
          <tr>
            <th scope="col">Fecha</th>
            <th scope="col">Peso</th>
            <th scope="col">Método</th>
            <th scope="col">Diferencia</th>
            <th scope="col">Días</th>
            <th scope="col">GMD</th>
            <th scope="col">Observaciones</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((p) => (
            <tr key={p.pesajeId}>
              <td data-label="Fecha">{formatFecha(p.fecha)}</td>
              <td data-label="Peso">{formatKg(p.pesoKg)}</td>
              <td data-label="Método">{formatMetodo(p.metodo)}</td>
              <td data-label="Diferencia">{formatDiferenciaKg(p.diferenciaKg)}</td>
              <td data-label="Días">{formatDias(p.diasDesdeAnterior)}</td>
              <td data-label="GMD">{formatGmd(p.gmdKgDia)}</td>
              <td data-label="Observaciones">{p.observaciones || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
