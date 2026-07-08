// Datos demo de Coronado y Esperanza. A partir de esta fase, edad, categoria, GDP/umbrales
// y estado sanitario se calculan con el mismo motor comun que usa la cuenta real
// (src/modules/ganaderia/engine/), no con formulas propias de la demo.
import { obtenerEdadMeses } from '../engine/edad.js';
import { clasificarCategoriaPorEdadSexo } from '../engine/categoria.js';
import { enrichRows, calcularGDP, calcularTendenciaPesajes, classifyProductivity, obtenerUmbralesGDP, thresholdText } from '../engine/pesajes.js';
import { daysUntil, vaccinationStatus, sanitaryGeneralStatus } from '../engine/sanidad.js';
import { formatComposicionRacial } from '../engine/genetica.js';

const STORAGE_KEY = 'agx_ganaderia_demo_v2';

function monthsAgo(n) {
  const date = new Date();
  date.setMonth(date.getMonth() - n);
  return date.toISOString();
}

function daysAgo(n) {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return date.toISOString();
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

// Formato es-CO (coma decimal) para texto narrativo, consistente con el resto de la demo.
function formatKgCO(value) {
  return Number.isFinite(value) ? value.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

function promedio(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Checkpoints de peso de Coronado: nacimiento -> destete -> levante -> alerta -> recuperación.
 * Los pesos son la narrativa aprobada (no cambian). Lo que sí cambia en esta fase: GDP,
 * categoría por checkpoint y estado productivo (Excelente/Aceptable/Crítico) ya no se
 * inventan a mano — se calculan con engine/pesajes.enrichRows, el mismo motor y los mismos
 * umbrales por categoría que usa AnimalPesajesTab.jsx en la cuenta real.
 */
function buildCoronado() {
  const razas = [{ nombre_raza: 'Brahman Rojo', porcentaje: 100 }];
  const identidadBase = {
    nombre: 'Coronado',
    codigoInterno: 'DEMO-BR-001',
    qrCodigo: 'AGX-DEMO-000001',
    sexo: 'Macho',
    raza: 'Brahman Rojo puro',
    composicionRacial: formatComposicionRacial(razas),
    fechaNacimiento: monthsAgo(20),
    categoria: 'Extra',
    pesoActualKg: 540,
    estadoComercial: 'Listo para comercialización',
    estadoProductivo: 'Finalización / Comercialización',
    predioReferencia: 'Predio El Roble (demo)',
    potreroReferencia: 'Potrero 2 (demo)',
  };
  identidadBase.edadMeses = obtenerEdadMeses({ fecha_nacimiento: identidadBase.fechaNacimiento });

  const checkpointsRaw = [
    { etapa: 'Nacimiento', mesesEdad: 0, pesoKg: 34 },
    { etapa: 'Destete', mesesEdad: 8, pesoKg: 220 },
    { etapa: 'Levante', mesesEdad: 12, pesoKg: 340 },
    { etapa: 'Levante avanzado', mesesEdad: 15, pesoKg: 410 },
    { etapa: 'Seguimiento de crecimiento', mesesEdad: 18, pesoKg: 470 },
    { etapa: 'Actual', mesesEdad: 20, pesoKg: 540 },
  ];

  const pesajeRows = checkpointsRaw.map((checkpoint, index) => ({
    etapa: checkpoint.etapa,
    fecha_pesaje: monthsAgo(20 - checkpoint.mesesEdad),
    peso_kg: checkpoint.pesoKg,
    es_peso_nacimiento: index === 0,
  }));

  // Mismo motor que la cuenta real: calcula peso anterior, dias entre pesajes, GDP,
  // categoria evaluada en cada fecha y estado productivo segun el umbral de esa categoria.
  const pesajes = enrichRows(pesajeRows, null, null, identidadBase);

  const primerosSeis = pesajes[0];
  const ultimoPesaje = pesajes[pesajes.length - 1];
  const penultimoPesaje = pesajes[pesajes.length - 2];
  const gdpGeneralKgDia = round2(calcularGDP(ultimoPesaje.peso_kg, primerosSeis.peso_kg, 20 * 30));
  const umbralesActuales = obtenerUmbralesGDP(ultimoPesaje.categoria_evaluada);
  const estadoActual = classifyProductivity(
    ultimoPesaje.ganancia_diaria_kg,
    ultimoPesaje.diferencia_kg,
    pesajes.filter((row) => Number.isFinite(row.ganancia_diaria_kg)).length >= 2,
    umbralesActuales,
  );
  const tendencia = calcularTendenciaPesajes(pesajes);

  return {
    identidad: identidadBase,
    genealogia: {
      padre: 'Duque de Oro',
      razaPadre: 'Brahman Rojo puro',
      madre: 'Diana',
      razaMadre: 'Brahman Rojo pura',
      pureza: 'Puro 100%',
      geneticaAvanzada: 'En preparación / No registrada',
    },
    origenReproductivo: {
      metodo: 'IATF (Inseminación Artificial a Tiempo Fijo)',
      descripcion:
        'Servicio por IATF — semen de Duque de Oro sobre Diana — aproximadamente 9 meses antes del nacimiento de Coronado.',
      nota: 'Origen reproductivo único y coherente: una sola madre biológica y gestante. No se registran monta natural ni FIV/transferencia embrionaria para este animal.',
    },
    pesajes,
    analisisPesajes: {
      gdpGeneralKgDia,
      interpretacion: `Categoría evaluada actual: ${ultimoPesaje.categoria_evaluada}. Umbral aplicado: ${thresholdText(umbralesActuales)}.`,
      alerta: `Punto de seguimiento a los ${checkpointsRaw[4].mesesEdad} meses: ${formatKgCO(penultimoPesaje.ganancia_diaria_kg)} kg/día — estado "${penultimoPesaje.estado_productivo}" para su categoría de ese momento (${penultimoPesaje.categoria_evaluada}).`,
      recomendacion: penultimoPesaje.estado_productivo_class === 'estado-vencida'
        ? 'Revisar carga parasitaria y calidad de pastoreo en el potrero asignado.'
        : 'Ganancia dentro de rango esperado para la categoría; mantener el plan de manejo actual.',
      evidenciaRecuperacion: `A los ${checkpointsRaw[5].mesesEdad} meses la ganancia diaria es de ${formatKgCO(ultimoPesaje.ganancia_diaria_kg)} kg/día — estado "${estadoActual.label}" (tendencia reciente: ${tendencia.tendencia}).`,
    },
    sanidad: [
      { etapa: 'Nacimiento', mesesEdad: 0, evento: 'Registro de calostro y cura de ombligo' },
      { etapa: '2 meses', mesesEdad: 2, evento: 'Primera vacuna (enfermedades clostridiales) + primera desparasitación' },
      { etapa: '8 meses (destete)', mesesEdad: 8, evento: 'Refuerzo de Aftosa + desparasitación' },
      { etapa: '12 meses', mesesEdad: 12, evento: 'Refuerzo semestral de Aftosa' },
      { etapa: '16 meses', mesesEdad: 16, evento: 'Tratamiento antiparasitario por carga parasitaria moderada' },
      { etapa: '20 meses (actual)', mesesEdad: 20, evento: 'Esquema sanitario al día, sin vencimientos pendientes' },
    ],
    estadoSanitario: 'Al día',
    tratamientoDestacado: {
      etapa: '16 meses',
      descripcion: 'Tratamiento antiparasitario por carga parasitaria moderada.',
      vinculadoA: 'Seguimiento de crecimiento (15–18 meses).',
      nota: 'Aplicado según indicación del médico veterinario a cargo. Este entorno demo no registra dosis, vías de aplicación ni nombres comerciales de medicamentos.',
    },
    reproduccion: {
      tipo: 'origen',
      resumen: 'Coronado no tiene ciclo reproductivo propio: como macho, su único evento reproductivo registrado es el origen por IATF que dio lugar a su nacimiento.',
    },
    comercializacion: {
      pesoObjetivoMinKg: 500,
      pesoObjetivoMaxKg: 600,
      pesoActualKg: 540,
      categoria: 'Extra',
      estado: 'Listo para comercialización',
      rutas: [
        {
          titulo: 'Vender ahora en categoría Extra',
          detalle: 'Aprovecha el peso y la categoría ya alcanzados, antes de que la eficiencia de conversión alimenticia empiece a bajar con la edad.',
        },
        {
          titulo: 'Retener como reproductor',
          detalle: 'Genealogía documentada y pureza racial 100% con buen desempeño de crecimiento — su valor genético puede superar su valor de comercialización como carne.',
        },
      ],
      indicadores: [
        'Peso final: 540 kg (dentro del rango objetivo 500–600 kg)',
        'Categoría: Extra',
        'Pureza racial: 100% Brahman Rojo',
        'Genealogía documentada (origen por IATF)',
        `Estado productivo actual: ${estadoActual.label} (motor común de pesajes)`,
      ],
    },
  };
}

/**
 * Producción diaria de leche de Esperanza: 18 registros, del más antiguo (hace 17 días)
 * al más reciente (hoy). Los últimos 3 días muestran una caída real de ~15% frente al
 * promedio de los 15 días anteriores, para que la alerta de caída de producción sea
 * consistente con los propios datos y no un texto suelto sin soporte numérico.
 */
function buildEsperanzaProduccionDiaria() {
  const litrosPorDiaAtras = {
    17: 17.4, 16: 17.8, 15: 17.2, 14: 18.0, 13: 17.6,
    12: 17.9, 11: 17.3, 10: 17.7, 9: 18.1, 8: 17.4,
    7: 17.8, 6: 17.6, 5: 17.9, 4: 17.5, 3: 17.7,
    2: 15.0, 1: 14.8, 0: 15.1,
  };

  return Object.entries(litrosPorDiaAtras)
    .map(([diasAtras, litros]) => ({
      diasAtras: Number(diasAtras),
      fecha: daysAgo(Number(diasAtras)),
      litros,
    }))
    .sort((a, b) => b.diasAtras - a.diasAtras);
}

function buildEsperanza() {
  const produccionDiaria = buildEsperanzaProduccionDiaria();
  const ultimos3 = produccionDiaria.filter((r) => r.diasAtras <= 2).map((r) => r.litros);
  const anteriores15 = produccionDiaria.filter((r) => r.diasAtras >= 3).map((r) => r.litros);
  const promedioReciente = round1(promedio(ultimos3));
  const promedioBase = round1(promedio(anteriores15));
  const caidaPorcentaje = round1(((promedioBase - promedioReciente) / promedioBase) * 100);
  const promedioSemanal = round1(promedio(produccionDiaria.filter((r) => r.diasAtras <= 6).map((r) => r.litros)));
  const promedioLactanciaHistorico = round1(2700 / 150);

  const identidadBase = {
    nombre: 'Esperanza',
    codigoInterno: 'DEMO-GF-002',
    qrCodigo: 'AGX-DEMO-000002',
    sexo: 'Hembra',
    raza: 'Girolando F1',
    composicionRacial: '50% Holstein x 50% Gyr',
    fechaNacimiento: monthsAgo(40),
    edadAproximada: '≈ 3,3 años',
    categoria: 'Vaca adulta en producción',
    estadoProductivo: 'En lactancia — día aproximado 150',
    predioReferencia: 'Predio El Roble (demo)',
    potreroReferencia: 'Potrero 2 (demo) — antes en Potrero 1 (demo)',
  };
  identidadBase.edadMeses = obtenerEdadMeses({ fecha_nacimiento: identidadBase.fechaNacimiento });
  // Categoría contextual del motor común (misma fuente que ficha/pesajes de la cuenta real).
  identidadBase.categoriaEtapa = clasificarCategoriaPorEdadSexo(
    { sexo: identidadBase.sexo, estado_reproductivo: 'lactante' },
    new Date().toISOString(),
    false,
    identidadBase.fechaNacimiento,
  );

  // Vacunas con fechas reales para que el estado (Vigente/Próxima a vencer/Vencida) salga
  // del mismo criterio real (engine/sanidad), no de un texto "Al día" escrito a mano.
  const vacunasBase = [
    { evento: 'Aftosa', fecha_aplicacion: monthsAgo(2), proxima_aplicacion: null, diasProxima: 120 },
    { evento: 'Desparasitación', fecha_aplicacion: monthsAgo(1), proxima_aplicacion: null, diasProxima: 60 },
  ];
  const hoy = new Date();
  const vacunasActivas = vacunasBase.map((vacuna) => {
    const proxima = new Date(hoy);
    proxima.setDate(proxima.getDate() + vacuna.diasProxima);
    const proximaISO = proxima.toISOString();
    return {
      evento: vacuna.evento,
      proxima_aplicacion: proximaISO,
      estado: vaccinationStatus({ proxima_aplicacion: proximaISO }),
      diasParaVencer: daysUntil(proximaISO),
    };
  });
  const vacunaHistorica = {
    evento: 'Brucelosis',
    estado: 'Registro histórico de novilla (no se repite en animales adultos)',
  };
  const resumenSanitario = {
    total: vacunasActivas.length,
    vigentes: vacunasActivas.filter((v) => v.estado === 'Vigente').length,
    proximas: vacunasActivas.filter((v) => v.estado === 'Próxima a vencer').length,
    vencidas: vacunasActivas.filter((v) => v.estado === 'Vencida').length,
  };
  const estadoSanitarioGeneral = sanitaryGeneralStatus(resumenSanitario);

  return {
    identidad: identidadBase,
    genealogia: {
      madre: 'Gitana',
      razaMadre: 'Gyr pura',
      padre: 'Holstein Imperial',
      razaPadre: 'Holstein puro',
      composicionRacial: '50% Holstein x 50% Gyr (Girolando F1)',
      origen: 'IA convencional con semen Holstein sobre vientre Gyr.',
      explicacionF1: 'Primera generación de cruce entre dos razas puras. Combina la alta producción lechera del Holstein con la adaptación tropical y la rusticidad del Gyr — por eso el Girolando es la raza lechera predominante en zonas tropicales de Colombia.',
      geneticaAvanzada: 'En preparación / No registrada',
    },
    reproduccion: {
      tipo: 'ciclo propio',
      estadoActual: 'Vacía, aún no servida en este ciclo de lactancia.',
      ultimoParto: monthsAgo(5),
      diasEnLeche: 150,
      primerPartoEdadMeses: 27,
      proximoEvento: 'Programar servicio en los próximos 30–45 días para mantener un intervalo entre partos cercano a 13–14 meses.',
    },
    produccionLeche: {
      registrosDiarios: produccionDiaria,
      promedioSemanalLitros: promedioSemanal,
      promedioLactanciaHistoricoLitros: promedioLactanciaHistorico,
      produccionAcumuladaLitros: 2700,
      diasEnLeche: 150,
      alerta: `Producción de leche cayó ${caidaPorcentaje}% en los últimos 3 días (de ${promedioBase} L/día a ${promedioReciente} L/día).`,
      recomendacion: 'Revisar alimentación, disponibilidad de agua o estrés calórico. La caída coincide con el cambio reciente de potrero.',
    },
    pesajesMensuales: [
      { etapa: 'Al parto', mesesDesdeParto: 0, pesoKg: 460 },
      { etapa: 'Mes 1', mesesDesdeParto: 1, pesoKg: 440 },
      { etapa: 'Mes 2', mesesDesdeParto: 2, pesoKg: 445 },
      { etapa: 'Mes 3', mesesDesdeParto: 3, pesoKg: 452 },
      { etapa: 'Mes 4', mesesDesdeParto: 4, pesoKg: 458 },
      { etapa: 'Mes 5 (actual)', mesesDesdeParto: 5, pesoKg: 462 },
    ],
    condicionCorporal: {
      valor: '3,0 / 5',
      interpretacion: 'Recupera condición corporal postparto mientras sostiene producción — señal de balance nutricional adecuado.',
    },
    sanidad: [...vacunasActivas, vacunaHistorica],
    estadoSanitario: `${estadoSanitarioGeneral.label} — ${estadoSanitarioGeneral.description}`,
    tratamientoDestacado: {
      descripcion: 'Mastitis subclínica leve — detectada y tratada, resuelta.',
      nota: 'Caso clínico común, sin complicaciones. Este entorno demo no registra dosis, vías de aplicación ni nombres comerciales de medicamentos.',
    },
  };
}

function seedDemoData() {
  return {
    casos: {
      coronado: buildCoronado(),
      esperanza: buildEsperanza(),
    },
  };
}

export function loadDemoData() {
  if (typeof window === 'undefined') return seedDemoData();

  try {
    window.localStorage?.removeItem(STORAGE_KEY);
    window.localStorage?.removeItem('agx_ganaderia_demo_v1');
    window.sessionStorage.removeItem('agx_ganaderia_demo_v1');
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = seedDemoData();
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    return JSON.parse(raw);
  } catch {
    return seedDemoData();
  }
}

export function saveDemoData(data) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Almacenamiento no disponible: la demo continúa solo en memoria de la sesión.
  }
}

export function resetDemoData() {
  const seeded = seedDemoData();
  saveDemoData(seeded);
  return seeded;
}
