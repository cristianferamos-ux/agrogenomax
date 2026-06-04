import { Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { createSanitaryHistoryPdfBlob, sanitaryHistoryFileName } from './sanitaryHistoryPdf.js';

const LABORATORIOS = [
  'Vecol',
  'Zoetis',
  'MSD Salud Animal',
  'Boehringer Ingelheim',
  'Virbac',
  'Ourofino',
  'Calier',
  'Carval',
  'Genfar',
  'Erma',
  'Otro',
];

const DOSIS = [
  'Primera dosis',
  'Segunda dosis',
  'Tercera dosis',
  'Refuerzo',
  'Revacunación',
  'Campaña oficial',
  'Dosis única',
  'Otro',
];

const FILTERS = ['Todas', 'Vigente', 'Próxima a vencer', 'Vencida', 'Sin programación'];

function todayLocal() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function emptyForm() {
  return {
    catalogo_vacuna_id: '',
    fecha_aplicacion: todayLocal(),
    lote: '',
    laboratorio: '',
    laboratorio_manual: '',
    dosis: '',
    dosis_manual: '',
    vacunador: '',
    matricula_profesional: '',
    entidad_registro_profesional: '',
    proxima_aplicacion: '',
    observaciones: '',
  };
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : '—';
}

function parseDate(value) {
  const date = formatDate(value);
  if (date === '—') return null;
  return new Date(`${date}T00:00:00`);
}

function daysUntil(value) {
  const date = parseDate(value);
  if (!date) return null;
  const today = new Date(`${todayLocal()}T00:00:00`);
  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function vaccinationStatus(vacunacion) {
  const days = daysUntil(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima);

  if (days === null) return 'Sin programación';
  if (days < 0) return 'Vencida';
  if (days <= 30) return 'Próxima a vencer';
  return 'Vigente';
}

function remainingDaysLabel(vacunacion) {
  const days = daysUntil(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima);

  if (days === null) return 'Sin programación';
  if (days === 0) return 'Vence hoy';
  if (days < 0) return `Vencida hace ${Math.abs(days)} días`;
  return `Vence en ${days} días`;
}

function alertClass(alerta) {
  if (alerta === 'Vencida') return 'estado-vencida';
  if (alerta === 'Próxima a vencer') return 'estado-proxima';
  if (alerta === 'Vigente') return 'estado-vigente';
  return 'estado-sin-programacion';
}

function vaccineLabel(row) {
  return row.nombre_vacuna || row.vacuna || `Vacuna ${row.catalogo_vacuna_id}`;
}

function animalLabel(animal) {
  return animal?.nombre || animal?.codigo_interno || animal?.codigo || `Animal ${animal?.animal_id || ''}`;
}

function valueOrDash(value) {
  return value === null || value === undefined || value === '' ? '--' : value;
}

function valueOrNotRegistered(value) {
  return value === null || value === undefined || value === '' ? 'No registrado' : value;
}

function doseLabel(value) {
  return value === null || value === undefined || value === '' ? 'No registrada' : value;
}

function optionalRegisteredLabel(value) {
  return value === null || value === undefined || value === '' ? 'No registrado' : value;
}

function animalQrLabel(animal) {
  const explicitCode = animal?.codigo_qr || animal?.qr_codigo || animal?.qr_payload;
  const explicitMatch = String(explicitCode || '').match(/AGX-\d{1,}/i);
  if (explicitMatch) return explicitMatch[0].toUpperCase();

  const fallbackSource = animal?.codigo_interno || animal?.numero_arete;
  const fallbackDigits = String(fallbackSource || '').match(/\d+/)?.[0];
  if (fallbackDigits) return `AGX-${fallbackDigits.padStart(6, '0').slice(-6)}`;

  return '--';
}

function animalBreedLabel(animal) {
  const breeds = [animal?.raza_principal, animal?.raza_secundaria, animal?.raza_terciaria].filter(Boolean);
  return breeds.length ? breeds.join(' / ') : '--';
}

function animalAgeLabel(animal) {
  if (!animal?.fecha_nacimiento) return '--';
  const birthDate = new Date(animal.fecha_nacimiento);
  if (Number.isNaN(birthDate.getTime())) return '--';
  const today = new Date(`${todayLocal()}T00:00:00`);
  let months = (today.getFullYear() - birthDate.getFullYear()) * 12 + today.getMonth() - birthDate.getMonth();
  if (today.getDate() < birthDate.getDate()) months -= 1;
  return months >= 0 ? `${months} meses` : '--';
}

function resolveOptionValue(selected, manual) {
  return selected === 'Otro' ? manual.trim() : selected;
}

function sanitaryGeneralStatus(resumen) {
  if (resumen.vencidas > 0) {
    return {
      label: 'Crítico',
      icon: '🔴',
      className: 'estado-vencida',
      description: 'Existe al menos una vacuna vencida.',
    };
  }

  if (resumen.proximas > 0) {
    return {
      label: 'Atención',
      icon: '🟡',
      className: 'estado-proxima',
      description: 'Existe al menos una vacuna próxima a vencer.',
    };
  }

  if (resumen.vencidas === 0 && resumen.proximas === 0 && resumen.total > 0 && resumen.vigentes === resumen.total) {
    return {
      label: 'Excelente',
      icon: '🟢',
      className: 'estado-vigente',
      description: 'Todas las vacunas programadas están vigentes.',
    };
  }

  return {
    label: 'Sin programación',
    icon: '⚪',
    className: 'estado-sin-programacion',
    description: 'No hay próximas aplicaciones programadas.',
  };
}

function complianceClass(resumen) {
  if (resumen.vencidas > 0) return 'estado-vencida';
  if (resumen.proximas > 0) return 'estado-proxima';
  return 'estado-vigente';
}

function statusIcon(estado) {
  if (estado === 'Vigente') return '🟢';
  if (estado === 'Próxima a vencer') return '🟡';
  if (estado === 'Vencida') return '🔴';
  return '⚪';
}

function countdownCapsuleLabel(vacunacion) {
  if (vacunacion.estado_sanitario === 'Vencida') return 'Vencida';
  if (vacunacion.estado_sanitario === 'Sin programación') return 'Sin programación';
  if (vacunacion.dias_numero === null || vacunacion.dias_numero === undefined) return 'Sin programación';
  if (vacunacion.dias_numero === 0) return 'Hoy';
  return `${vacunacion.dias_numero} días`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function printableValue(value, fallback = '--') {
  return escapeHtml(value === null || value === undefined || value === '' ? fallback : value);
}

export default function AnimalVacunacionesTab({ animalId }) {
  const params = useParams();
  const resolvedAnimalId = animalId || params.id;
  const [animal, setAnimal] = useState(null);
  const [catalogo, setCatalogo] = useState([]);
  const [vacunaciones, setVacunaciones] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('Todas');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const load = async () => {
    if (!resolvedAnimalId) return;
    setLoading(true);
    setError('');
    try {
      const [animalRow, catalogoRows, vacunacionRows] = await Promise.all([
        ganaderiaApi.getAnimal(resolvedAnimalId),
        ganaderiaApi.listCatalogoVacunas(),
        ganaderiaApi.listAnimalVacunaciones(resolvedAnimalId),
      ]);
      setAnimal(animalRow);
      setCatalogo(catalogoRows);
      setVacunaciones(vacunacionRows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [resolvedAnimalId]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const vacunacionesConEstado = useMemo(
    () =>
      vacunaciones.map((vacunacion) => ({
        ...vacunacion,
        estado_sanitario: vaccinationStatus(vacunacion),
        dias_restantes: remainingDaysLabel(vacunacion),
        dias_numero: daysUntil(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima),
      })),
    [vacunaciones],
  );

  const resumen = useMemo(() => {
    const count = (estado) => vacunacionesConEstado.filter((vacunacion) => vacunacion.estado_sanitario === estado).length;
    const programadas = vacunacionesConEstado.filter((vacunacion) => vacunacion.estado_sanitario !== 'Sin programación').length;
    const estaSemana = vacunacionesConEstado.filter((vacunacion) => {
      const days = vacunacion.dias_numero;
      return days !== null && days >= 0 && days <= 7;
    }).length;

    return {
      total: vacunacionesConEstado.length,
      vigentes: count('Vigente'),
      proximas: count('Próxima a vencer'),
      vencidas: count('Vencida'),
      estaSemana,
      cumplimiento: programadas > 0 ? Math.round((count('Vigente') / programadas) * 100) : null,
    };
  }, [vacunacionesConEstado]);

  const cumplimientoVisual = resumen.cumplimiento ?? 0;
  const estadoGeneral = useMemo(() => sanitaryGeneralStatus(resumen), [resumen]);
  const cumplimientoClass = complianceClass(resumen);

  const filteredVacunaciones = useMemo(
    () =>
      filter === 'Todas'
        ? vacunacionesConEstado
        : vacunacionesConEstado.filter((vacunacion) => vacunacion.estado_sanitario === filter),
    [filter, vacunacionesConEstado],
  );

  const calendario = useMemo(
    () =>
      [...filteredVacunaciones].sort((a, b) => {
        const dateA = parseDate(a.proxima_aplicacion || a.fecha_proxima)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const dateB = parseDate(b.proxima_aplicacion || b.fecha_proxima)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return dateA - dateB || String(vaccineLabel(a)).localeCompare(String(vaccineLabel(b)), 'es');
      }),
    [filteredVacunaciones],
  );

  const alertas = useMemo(
    () => calendario.filter((vacunacion) => ['Vencida', 'Próxima a vencer', 'Sin programación'].includes(vacunacion.estado_sanitario)),
    [calendario],
  );

  const alertaPrincipal = useMemo(() => {
    const ordered = [...vacunacionesConEstado].sort((a, b) => {
      const priority = { Vencida: 1, 'Próxima a vencer': 2, 'Sin programación': 3, Vigente: 4 };
      const priorityA = priority[a.estado_sanitario] || 5;
      const priorityB = priority[b.estado_sanitario] || 5;
      const daysA = a.dias_numero ?? Number.MAX_SAFE_INTEGER;
      const daysB = b.dias_numero ?? Number.MAX_SAFE_INTEGER;
      return priorityA - priorityB || daysA - daysB;
    });
    return ordered.find((vacunacion) => ['Vencida', 'Próxima a vencer'].includes(vacunacion.estado_sanitario)) || null;
  }, [vacunacionesConEstado]);

  const buildSanitaryHistoryHtml = () => {
    const generatedAt = new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
    const rows = vacunacionesConEstado.map((vacunacion) => `
      <tr>
        <td>${printableValue(vaccineLabel(vacunacion))}</td>
        <td>${printableValue(formatDate(vacunacion.fecha_aplicacion))}</td>
        <td>${printableValue(formatDate(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima))}</td>
        <td>${printableValue(vacunacion.dias_restantes)}</td>
        <td><span class="status ${escapeHtml(alertClass(vacunacion.estado_sanitario))}">${printableValue(vacunacion.estado_sanitario)}</span></td>
        <td>${printableValue(vacunacion.laboratorio)}</td>
        <td>${printableValue(vacunacion.lote)}</td>
        <td>${printableValue(vacunacion.dosis)}</td>
        <td>${printableValue(vacunacion.vacunador || vacunacion.aplicado_por, 'No registrado')}</td>
        <td>${printableValue(vacunacion.matricula_profesional, 'No registrado')}</td>
        <td>${printableValue(vacunacion.entidad_registro_profesional, 'No registrado')}</td>
        <td>${printableValue(vacunacion.observaciones)}</td>
      </tr>
    `).join('');

    return `<!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Historial Sanitario - ${printableValue(animalLabel(animal))}</title>
          <style>
            :root { color-scheme: light; }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              background: #f5f7fb;
              color: #101820;
              font-family: Inter, Arial, sans-serif;
              line-height: 1.45;
            }
            main {
              margin: 0 auto;
              max-width: 1120px;
              padding: 28px;
            }
            .header {
              border-bottom: 3px solid #9aff00;
              display: flex;
              justify-content: space-between;
              gap: 20px;
              padding-bottom: 18px;
            }
            .brand {
              color: #0b1117;
              font-size: 30px;
              font-weight: 900;
              letter-spacing: -0.02em;
            }
            .brand span { color: #4e8f00; }
            h1 {
              font-size: 22px;
              margin: 6px 0 0;
              text-transform: uppercase;
            }
            .generated {
              color: #526070;
              font-size: 13px;
              text-align: right;
            }
            .section {
              background: #ffffff;
              border: 1px solid #dce3ec;
              border-radius: 12px;
              margin-top: 18px;
              padding: 18px;
            }
            .section h2 {
              font-size: 15px;
              letter-spacing: 0.08em;
              margin: 0 0 12px;
              text-transform: uppercase;
            }
            .animal-grid,
            .summary-grid {
              display: grid;
              gap: 10px;
              grid-template-columns: repeat(5, minmax(0, 1fr));
            }
            .animal-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            .metric {
              border: 1px solid #e1e7ef;
              border-radius: 10px;
              padding: 12px;
            }
            .metric span {
              color: #607083;
              display: block;
              font-size: 12px;
              font-weight: 700;
              text-transform: uppercase;
            }
            .metric strong {
              display: block;
              font-size: 18px;
              margin-top: 5px;
            }
            table {
              border-collapse: collapse;
              font-size: 12px;
              width: 100%;
            }
            th, td {
              border-bottom: 1px solid #e1e7ef;
              padding: 9px 8px;
              text-align: left;
              vertical-align: top;
            }
            th {
              background: #101820;
              color: #ffffff;
              font-size: 11px;
              letter-spacing: 0.04em;
              text-transform: uppercase;
            }
            .table-wrap { overflow-x: auto; }
            .status {
              border-radius: 999px;
              display: inline-block;
              font-weight: 800;
              padding: 4px 8px;
              white-space: nowrap;
            }
            .estado-vigente { background: #e8ffd1; color: #3f7e00; }
            .estado-proxima { background: #fff5bf; color: #8a6a00; }
            .estado-vencida { background: #ffe1e1; color: #b42121; }
            .estado-sin-programacion { background: #e8edf3; color: #526070; }
            .empty {
              border: 1px dashed #b9c4d0;
              border-radius: 10px;
              color: #526070;
              padding: 18px;
              text-align: center;
            }
            @media print {
              body { background: #ffffff; }
              main { max-width: none; padding: 0; }
              .section { break-inside: avoid; }
              .no-print { display: none; }
            }
            @media (max-width: 760px) {
              main { padding: 16px; }
              .header { display: block; }
              .generated { margin-top: 8px; text-align: left; }
              .animal-grid,
              .summary-grid { grid-template-columns: 1fr; }
            }
          </style>
        </head>
        <body>
          <main>
            <section class="header">
              <div>
                <div class="brand">Agro<span>Genoma</span>X By CRH</div>
                <h1>Historial Sanitario</h1>
              </div>
              <div class="generated">Fecha de generación<br /><strong>${escapeHtml(generatedAt)}</strong></div>
            </section>

            <section class="section">
              <h2>Animal</h2>
              <div class="animal-grid">
                <div class="metric"><span>Nombre</span><strong>${printableValue(animalLabel(animal))}</strong></div>
                <div class="metric"><span>QR</span><strong>${printableValue(animalQrLabel(animal))}</strong></div>
                <div class="metric"><span>Raza</span><strong>${printableValue(animalBreedLabel(animal))}</strong></div>
                <div class="metric"><span>Sexo</span><strong>${printableValue(animal?.sexo)}</strong></div>
                <div class="metric"><span>Edad</span><strong>${printableValue(animalAgeLabel(animal))}</strong></div>
              </div>
            </section>

            <section class="section">
              <h2>Resumen</h2>
              <div class="summary-grid">
                <div class="metric"><span>Total vacunas registradas</span><strong>${resumen.total}</strong></div>
                <div class="metric"><span>Vacunas vigentes</span><strong>${resumen.vigentes}</strong></div>
                <div class="metric"><span>Próximas a vencer</span><strong>${resumen.proximas}</strong></div>
                <div class="metric"><span>Vencidas</span><strong>${resumen.vencidas}</strong></div>
                <div class="metric"><span>Cumplimiento sanitario</span><strong>${resumen.cumplimiento === null ? '--' : `${resumen.cumplimiento}%`}</strong></div>
              </div>
            </section>

            <section class="section">
              <h2>Vacunaciones registradas</h2>
              ${vacunacionesConEstado.length ? `
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Vacuna</th>
                        <th>Fecha aplicación</th>
                        <th>Próxima aplicación</th>
                        <th>Cuenta regresiva</th>
                        <th>Estado</th>
                        <th>Laboratorio</th>
                        <th>Lote</th>
                        <th>Dosis</th>
                        <th>Vacunador</th>
                        <th>Matrícula profesional</th>
                        <th>Registro profesional</th>
                        <th>Observaciones</th>
                      </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                  </table>
                </div>
              ` : '<p class="empty">No existen vacunaciones registradas para este animal.</p>'}
            </section>
          </main>
        </body>
      </html>`;
  };

  const downloadSanitaryHistory = async () => {
    setStatus('');
    setError('');
    setGeneratingPdf(true);

    try {
      const animalName = animalLabel(animal);
      const qrCode = animalQrLabel(animal);
      const generatedAt = new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
      const blob = await createSanitaryHistoryPdfBlob({
        animal: {
          nombre: animalName,
          qr: qrCode,
          raza: animalBreedLabel(animal),
          sexo: valueOrDash(animal?.sexo),
          edad: animalAgeLabel(animal),
          predio: valueOrDash(animal?.nombre_predio || animal?.predio || animal?.predio_nombre),
          potrero: valueOrDash(animal?.nombre_potrero || animal?.potrero || animal?.potrero_nombre),
          authUrl: `https://agrogenomax.pages.dev/qr/${encodeURIComponent(qrCode)}`,
        },
        resumen: {
          total: resumen.total,
          vigentes: resumen.vigentes,
          proximas: resumen.proximas,
          vencidas: resumen.vencidas,
          cumplimiento: resumen.cumplimiento === null ? '--' : `${resumen.cumplimiento}%`,
        },
        estadoGeneral: estadoGeneral.label,
        vacunaciones: vacunacionesConEstado.map((vacunacion) => ({
          vacuna: vaccineLabel(vacunacion),
          fechaAplicacion: formatDate(vacunacion.fecha_aplicacion),
          proximaAplicacion: formatDate(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima),
          cuentaRegresiva: vacunacion.dias_restantes,
          estado: vacunacion.estado_sanitario,
          laboratorio: valueOrDash(vacunacion.laboratorio),
          lote: valueOrDash(vacunacion.lote),
          dosis: valueOrDash(vacunacion.dosis),
          vacunador: optionalRegisteredLabel(vacunacion.vacunador || vacunacion.aplicado_por),
          matricula: optionalRegisteredLabel(vacunacion.matricula_profesional),
          registro: optionalRegisteredLabel(vacunacion.entidad_registro_profesional),
          aplicadoPor: optionalRegisteredLabel(vacunacion.aplicado_por),
          veterinario: optionalRegisteredLabel(vacunacion.veterinario_responsable || vacunacion.veterinario),
          observaciones: valueOrDash(vacunacion.observaciones),
        })),
        generatedAt,
      });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
      link.download = sanitaryHistoryFileName(animalName, qrCode);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setStatus('Historial sanitario descargado en PDF.');
    } catch (err) {
      setError(err.message || 'No se pudo generar el PDF sanitario.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (!resolvedAnimalId) {
      setError('No hay animal válido para registrar vacunación.');
      return;
    }

    if (!form.catalogo_vacuna_id) {
      setError('Selecciona una vacuna del catálogo.');
      return;
    }

    if (!form.fecha_aplicacion) {
      setError('La fecha de aplicación es obligatoria.');
      return;
    }

    const laboratorioFinal = resolveOptionValue(form.laboratorio, form.laboratorio_manual);
    const dosisFinal = resolveOptionValue(form.dosis, form.dosis_manual);

    if (form.laboratorio === 'Otro' && !laboratorioFinal) {
      setError('Especifica el laboratorio.');
      return;
    }

    if (form.dosis === 'Otro' && !dosisFinal) {
      setError('Especifica la dosis.');
      return;
    }

    if (!form.vacunador.trim()) {
      setError('Registra el vacunador responsable.');
      return;
    }

    if (!form.matricula_profesional.trim()) {
      setError('Registra la matrícula profesional del vacunador.');
      return;
    }

    try {
      await ganaderiaApi.createVacunacion({
        animal_id: resolvedAnimalId,
        catalogo_vacuna_id: form.catalogo_vacuna_id,
        fecha_aplicacion: form.fecha_aplicacion,
        lote: form.lote,
        laboratorio: laboratorioFinal,
        dosis: dosisFinal,
        vacunador: form.vacunador.trim(),
        matricula_profesional: form.matricula_profesional.trim(),
        entidad_registro_profesional: form.entidad_registro_profesional.trim(),
        proxima_aplicacion: form.proxima_aplicacion,
        observaciones: form.observaciones,
      });
      setForm(emptyForm());
      setStatus('Vacunación registrada en PostgreSQL');
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="gan-stack">
      <div className="gan-metric-grid gan-health-summary">
        <article className="gan-metric estado-vigente">
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">🛡️</span><span>Vacunas vigentes</span></span>
          <strong>{resumen.vigentes}</strong>
        </article>
        <article className="gan-metric estado-proxima">
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">🔔</span><span>Próximas a vencer</span></span>
          <strong>{resumen.proximas}</strong>
        </article>
        <article className="gan-metric estado-vencida">
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">⚠️</span><span>Vencidas</span></span>
          <strong>{resumen.vencidas}</strong>
        </article>
        <article className={`gan-metric gan-week-card ${resumen.estaSemana > 0 ? 'estado-proxima' : 'estado-vigente'}`}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">📅</span><span>Próximas aplicaciones esta semana</span></span>
          <strong className="gan-week-count">{resumen.estaSemana} {resumen.estaSemana === 1 ? 'aplicación' : 'aplicaciones'}</strong>
        </article>
        <article className={`gan-metric gan-compliance-card ${cumplimientoClass}`}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">📊</span><span>Cumplimiento sanitario</span></span>
          <strong>{resumen.cumplimiento === null ? '—' : `${resumen.cumplimiento}%`}</strong>
          <div className="gan-progress-bar" aria-label="Cumplimiento sanitario">
            <span style={{ width: `${cumplimientoVisual}%` }} />
          </div>
        </article>
        <article className={`gan-metric gan-general-status ${estadoGeneral.className}`}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">{estadoGeneral.icon}</span><span>Estado sanitario general</span></span>
          <strong>{estadoGeneral.label}</strong>
          <small>{estadoGeneral.description}</small>
        </article>
      </div>

      <div className="gan-breed-box gan-animal-dashboard">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Resumen sanitario del animal</span>
          <h3>{animalLabel(animal)}</h3>
        </div>
        <div className="gan-animal-meta">
          <span><strong>QR:</strong> {animalQrLabel(animal)}</span>
          <span><strong>Raza:</strong> {animalBreedLabel(animal)}</span>
          <span><strong>Sexo:</strong> {valueOrDash(animal?.sexo)}</span>
          <span><strong>Edad:</strong> {animalAgeLabel(animal)}</span>
        </div>
        <div className="gan-dashboard-grid">
          <article className="estado-neutro"><span>Total vacunas registradas</span><strong>{resumen.total}</strong></article>
          <article className="estado-vigente"><span>Vacunas vigentes</span><strong>{resumen.vigentes}</strong></article>
          <article className="estado-proxima"><span>Próximas a vencer</span><strong>{resumen.proximas}</strong></article>
          <article className="estado-vencida"><span>Vencidas</span><strong>{resumen.vencidas}</strong></article>
          <article className={cumplimientoClass}><span>Cumplimiento sanitario</span><strong>{resumen.cumplimiento === null ? '—' : `${resumen.cumplimiento}%`}</strong></article>
        </div>
      </div>

      <div className="gan-filter-row" aria-label="Filtro de estado sanitario">
        {FILTERS.map((item) => (
          <button
            className={`${filter === item ? 'is-active' : ''} ${item === 'Todas' ? 'estado-todas' : alertClass(item)}`}
            key={item}
            onClick={() => setFilter(item)}
            type="button"
          >
            {item === 'Todas' ? item : `${item} (${vacunacionesConEstado.filter((vacunacion) => vacunacion.estado_sanitario === item).length})`}
          </button>
        ))}
      </div>

      <form className="gan-form" onSubmit={submit}>
        <FormField label="Vacuna">
          <select value={form.catalogo_vacuna_id} onChange={(event) => update('catalogo_vacuna_id', event.target.value)} required>
            <option value="">Seleccionar vacuna del catálogo</option>
            {catalogo.map((vacuna) => (
              <option key={vacuna.catalogo_vacuna_id} value={vacuna.catalogo_vacuna_id}>
                {vaccineLabel(vacuna)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Fecha aplicación">
          <input type="date" value={form.fecha_aplicacion} onChange={(event) => update('fecha_aplicacion', event.target.value)} required />
        </FormField>
        <FormField label="Próxima aplicación">
          <input type="date" value={form.proxima_aplicacion} onChange={(event) => update('proxima_aplicacion', event.target.value)} />
        </FormField>
        <FormField label="Lote">
          <input value={form.lote} onChange={(event) => update('lote', event.target.value)} />
        </FormField>
        <FormField label="Laboratorio">
          <select value={form.laboratorio} onChange={(event) => update('laboratorio', event.target.value)}>
            <option value="">Seleccionar laboratorio</option>
            {LABORATORIOS.map((laboratorio) => (
              <option key={laboratorio} value={laboratorio}>
                {laboratorio}
              </option>
            ))}
          </select>
        </FormField>
        {form.laboratorio === 'Otro' ? (
          <FormField label="Especifique laboratorio">
            <input value={form.laboratorio_manual} onChange={(event) => update('laboratorio_manual', event.target.value)} required />
          </FormField>
        ) : null}
        <FormField label="Dosis">
          <select value={form.dosis} onChange={(event) => update('dosis', event.target.value)}>
            <option value="">Seleccionar dosis</option>
            {DOSIS.map((dosis) => (
              <option key={dosis} value={dosis}>
                {dosis}
              </option>
            ))}
          </select>
        </FormField>
        {form.dosis === 'Otro' ? (
          <FormField label="Especifique dosis">
            <input value={form.dosis_manual} onChange={(event) => update('dosis_manual', event.target.value)} required />
          </FormField>
        ) : null}
        <FormField label="Vacunador">
          <input
            placeholder="Dr. Juan Pérez"
            value={form.vacunador}
            onChange={(event) => update('vacunador', event.target.value)}
            required
          />
        </FormField>
        <FormField label="Número de matrícula profesional">
          <input
            placeholder="MV-54872"
            value={form.matricula_profesional}
            onChange={(event) => update('matricula_profesional', event.target.value)}
            required
          />
        </FormField>
        <FormField label="Entidad o registro profesional">
          <input
            placeholder="COMVEZCOL"
            value={form.entidad_registro_profesional}
            onChange={(event) => update('entidad_registro_profesional', event.target.value)}
          />
        </FormField>
        <FormField label="Observaciones">
          <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
        </FormField>
        <button className="gan-submit" type="submit">
          <Save className="h-5 w-5" />
          Guardar vacunación
        </button>
      </form>

      {!catalogo.length && !loading ? (
        <p className="gan-empty-text">No hay vacunas activas en el catálogo sanitario.</p>
      ) : null}
      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>

      <div className={`gan-feature-alert gan-feature-alert-premium ${alertaPrincipal ? alertClass(alertaPrincipal.estado_sanitario) : 'estado-vigente'}`}>
        {alertaPrincipal ? (
          <>
            <span className="gan-feature-icon" aria-hidden="true">{alertaPrincipal.estado_sanitario === 'Vencida' ? '🚨' : '⚠️'}</span>
            <div>
              <span className="gan-feature-kicker">Alerta sanitaria</span>
              <strong>{vaccineLabel(alertaPrincipal)}</strong>
              <span>Animal: {animalLabel(animal)}</span>
              <span>Laboratorio: {valueOrDash(alertaPrincipal.laboratorio)}</span>
              <span>Dosis: {doseLabel(alertaPrincipal.dosis)}</span>
              <span>👨‍⚕️ Vacunador: {optionalRegisteredLabel(alertaPrincipal.vacunador || alertaPrincipal.aplicado_por)}</span>
              <small>{alertaPrincipal.dias_restantes}</small>
            </div>
          </>
        ) : (
          <>
            <span className="gan-feature-icon" aria-hidden="true">✅</span>
            <div>
              <span className="gan-feature-kicker">Sin alertas sanitarias</span>
              <strong>Sin alertas sanitarias</strong>
              <small>El animal no tiene vacunas vencidas ni próximas a vencer.</small>
            </div>
          </>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Resumen sanitario</span>
          <h3>Calendario de próximas aplicaciones</h3>
        </div>
        {loading ? (
          <p className="gan-empty-text">Cargando calendario sanitario...</p>
        ) : calendario.length ? (
          <div className="gan-vaccine-calendar">
            <div className="gan-vaccine-calendar-head">
              <span>Fecha</span>
              <span>Animal</span>
              <span>Vacuna</span>
              <span>Laboratorio</span>
              <span>Cuenta regresiva</span>
              <span>Estado</span>
            </div>
            {calendario.map((vacunacion) => (
              <article className="gan-vaccine-calendar-row" key={`cal-${vacunacion.vacunacion_id}`}>
                <span data-label="Fecha">{formatDate(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima)}</span>
                <span data-label="Animal">{animalLabel(animal)}</span>
                <strong data-label="Vacuna">{vaccineLabel(vacunacion)}</strong>
                <span data-label="Laboratorio">{vacunacion.laboratorio || '—'}</span>
                <span className="gan-countdown-stack" data-label="Cuenta regresiva">
                  <span>{vacunacion.dias_restantes}</span>
                  <span className={`gan-countdown-pill ${alertClass(vacunacion.estado_sanitario)}`}>
                    {statusIcon(vacunacion.estado_sanitario)} {countdownCapsuleLabel(vacunacion)}
                  </span>
                </span>
                <span data-label="Estado" className={`gan-alert-pill ${alertClass(vacunacion.estado_sanitario)}`}>{statusIcon(vacunacion.estado_sanitario)} {vacunacion.estado_sanitario}</span>
              </article>
            ))}
          </div>
        ) : (
          <p className="gan-empty-text">Sin próximas aplicaciones para este filtro.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Alertas sanitarias</span>
          <h3>Seguimiento sanitario</h3>
        </div>
        {loading ? (
          <p className="gan-empty-text">Cargando alertas...</p>
        ) : alertas.length ? (
          <div className="gan-vaccine-list">
            {alertas.map((vacunacion) => (
              <article className="gan-vaccine-row" key={`alert-${vacunacion.vacunacion_id}`}>
                <div>
                  <strong>{vaccineLabel(vacunacion)}</strong>
                  <span>Animal: {animalLabel(animal)}</span>
                  <span>Laboratorio: {vacunacion.laboratorio || '—'}</span>
                  <span>Dosis: {doseLabel(vacunacion.dosis)}</span>
                  <span>👨‍⚕️ Vacunador: {optionalRegisteredLabel(vacunacion.vacunador || vacunacion.aplicado_por)}</span>
                  <span>Próxima aplicación: {formatDate(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima)}</span>
                  <span>{vacunacion.dias_restantes}</span>
                  <span className={`gan-countdown-pill ${alertClass(vacunacion.estado_sanitario)}`}>
                    {statusIcon(vacunacion.estado_sanitario)} {countdownCapsuleLabel(vacunacion)}
                  </span>
                </div>
                <span className={`gan-alert-pill ${alertClass(vacunacion.estado_sanitario)}`}>{statusIcon(vacunacion.estado_sanitario)} {vacunacion.estado_sanitario}</span>
              </article>
            ))}
          </div>
        ) : (
          <p className="gan-empty-text">Sin alertas sanitarias para este filtro.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Historial sanitario</span>
          <h3>Vacunaciones registradas</h3>
          <button
            className={`gan-secondary-button gan-pdf-button ${generatingPdf ? 'is-loading' : ''}`}
            disabled={generatingPdf}
            onClick={downloadSanitaryHistory}
            type="button"
          >
            📄 {generatingPdf ? 'Generando historial...' : 'Descargar historial sanitario'}
          </button>
        </div>
        {loading ? (
          <p className="gan-empty-text">Cargando vacunaciones...</p>
        ) : filteredVacunaciones.length ? (
          <div className="gan-vaccine-list">
            {filteredVacunaciones.map((vacunacion) => (
              <article className="gan-vaccine-row" key={vacunacion.vacunacion_id}>
                <div>
                  <strong className={`gan-vaccine-title ${alertClass(vacunacion.estado_sanitario)}`}>💉 {vaccineLabel(vacunacion)}</strong>
                  <span>📅 Fecha aplicación: {formatDate(vacunacion.fecha_aplicacion)}</span>
                  <span>🔄 Próxima aplicación: {formatDate(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima)}</span>
                  <span>{vacunacion.dias_restantes}</span>
                  <span className={`gan-countdown-pill ${alertClass(vacunacion.estado_sanitario)}`}>
                    {statusIcon(vacunacion.estado_sanitario)} {countdownCapsuleLabel(vacunacion)}
                  </span>
                  <span>🏢 Laboratorio: {vacunacion.laboratorio || '—'}</span>
                  <span>👨‍⚕️ Aplicado por: {valueOrNotRegistered(vacunacion.aplicado_por)}</span>
                  <span>🩺 Veterinario responsable: {valueOrNotRegistered(vacunacion.veterinario_responsable || vacunacion.veterinario)}</span>
                  <span>🏷️ Lote: {vacunacion.lote || '—'}</span>
                  <span>💉 Dosis: {vacunacion.dosis || '—'}</span>
                  <span>👨‍⚕️ Vacunador: {optionalRegisteredLabel(vacunacion.vacunador || vacunacion.aplicado_por)}</span>
                  <span>📋 Matrícula profesional: {optionalRegisteredLabel(vacunacion.matricula_profesional)}</span>
                  <span>🏛️ Registro: {optionalRegisteredLabel(vacunacion.entidad_registro_profesional)}</span>
                </div>
                <span className={`gan-alert-pill ${alertClass(vacunacion.estado_sanitario)}`}>{statusIcon(vacunacion.estado_sanitario)} {vacunacion.estado_sanitario}</span>
                {vacunacion.observaciones ? <small>{vacunacion.observaciones}</small> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="gan-empty-text">Sin vacunaciones para este filtro.</p>
        )}
      </div>
    </div>
  );
}
