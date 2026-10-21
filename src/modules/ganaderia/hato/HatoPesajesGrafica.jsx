// FASE 1B: gráficas de pesajes con Recharts (se carga en diferido desde
// HatoPesajesPanel para no engordar el bundle principal).
//   * Peso vs fecha: eje X TEMPORAL real (type="number", scale="time"): los
//     intervalos desiguales entre pesajes se respetan. Puntos visibles; con
//     un único pesaje solo se dibuja el punto (sin línea de tendencia).
//   * GMD por período (kg/día) en la fecha final de cada período: los null
//     no se dibujan; línea de referencia en 0. Sin umbrales de interpretación.
// Los datos completos están en la tabla de historial (alternativa accesible).
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  dominioTemporal,
  formatFecha,
  formatGmd,
  formatKg,
  formatMetodo,
  puntosGmd,
  puntosPeso,
  tiempoAFecha,
} from './pesajesModel.js';

const tickFecha = (t) => formatFecha(tiempoAFecha(t));
const tickNumero = (v) => Number(v).toLocaleString('es-CO', { maximumFractionDigits: 2 });

function TooltipPeso({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="gan-pesajes-tooltip">
      <strong>{formatFecha(p.fecha)}</strong>
      <span>{formatKg(p.pesoKg)}</span>
      <span>{formatMetodo(p.metodo)}</span>
    </div>
  );
}

function TooltipGmd({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="gan-pesajes-tooltip">
      <strong>Hasta {formatFecha(p.fecha)}</strong>
      <span>{formatGmd(p.gmdKgDia)}</span>
      <span>{p.diasDesdeAnterior} días</span>
    </div>
  );
}

export default function HatoPesajesGrafica({ pesajes }) {
  const peso = puntosPeso(pesajes);
  const gmd = puntosGmd(pesajes);
  if (!peso.length) return null;
  const dominioPeso = dominioTemporal(peso);
  const dominioGmd = dominioTemporal(gmd);

  return (
    <div className="gan-pesajes-graficas">
      <figure className="gan-pesajes-grafica">
        <figcaption>Peso por fecha (kg)</figcaption>
        <div role="img" aria-label={`Gráfica de peso: ${peso.length} pesaje${peso.length === 1 ? '' : 's'} entre ${formatFecha(peso[0].fecha)} y ${formatFecha(peso.at(-1).fecha)}.`}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={peso} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={dominioPeso} tickFormatter={tickFecha} minTickGap={24} />
              <YAxis dataKey="pesoKg" domain={['auto', 'auto']} unit=" kg" width={64} tickFormatter={tickNumero} />
              <Tooltip content={<TooltipPeso />} />
              <Line type="linear" dataKey="pesoKg" stroke="var(--gan-pesajes-linea, #9cff1a)" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </figure>

      {gmd.length ? (
        <figure className="gan-pesajes-grafica gan-pesajes-grafica-gmd">
          <figcaption>GMD por período (kg/día)</figcaption>
          <div role="img" aria-label={`Gráfica de GMD: ${gmd.length} período${gmd.length === 1 ? '' : 's'} con ganancia calculada.`}>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={gmd} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" type="number" scale="time" domain={dominioGmd} tickFormatter={tickFecha} minTickGap={24} />
                <YAxis dataKey="gmdKgDia" domain={['auto', 'auto']} width={64} tickFormatter={tickNumero} />
                <ReferenceLine y={0} stroke="#888" strokeDasharray="4 4" />
                <Tooltip content={<TooltipGmd />} />
                <Line type="linear" dataKey="gmdKgDia" stroke="var(--gan-pesajes-gmd, #6ea8ff)" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>
      ) : null}
    </div>
  );
}
