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
  return Math.round(value * 100) / 100;
}

function promedio(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Checkpoints de peso de Coronado: nacimiento -> destete -> levante -> alerta -> recuperación.
 * La ganancia diaria promedio (GDP) de cada tramo se calcula a partir de los mismos
 * checkpoints para que la alerta de desaceleración (15-18 meses) sea siempre consistente
 * con los pesos declarados, sin duplicar el número en dos lugares distintos.
 */
function buildCoronadoPesajes() {
  const checkpoints = [
    { etapa: 'Nacimiento', mesesEdad: 0, pesoKg: 34 },
    { etapa: 'Destete', mesesEdad: 8, pesoKg: 220 },
    { etapa: 'Levante', mesesEdad: 12, pesoKg: 340 },
    { etapa: 'Levante avanzado', mesesEdad: 15, pesoKg: 410 },
    { etapa: 'Alerta de desaceleración', mesesEdad: 18, pesoKg: 470 },
    { etapa: 'Actual', mesesEdad: 20, pesoKg: 540 },
  ];

  return checkpoints.map((checkpoint, index) => {
    const fecha = monthsAgo(20 - checkpoint.mesesEdad);
    if (index === 0) {
      return { ...checkpoint, fecha, gdpKgDia: null };
    }
    const anterior = checkpoints[index - 1];
    const diasPeriodo = (checkpoint.mesesEdad - anterior.mesesEdad) * 30;
    const gdpKgDia = round2((checkpoint.pesoKg - anterior.pesoKg) / diasPeriodo);
    return { ...checkpoint, fecha, gdpKgDia };
  });
}

function buildCoronado() {
  const pesajes = buildCoronadoPesajes();
  const gdpGeneral = round2((540 - 34) / (20 * 30));

  return {
    identidad: {
      nombre: 'Coronado',
      codigoInterno: 'DEMO-BR-001',
      qrCodigo: 'AGX-DEMO-000001',
      sexo: 'Macho',
      raza: 'Brahman Rojo puro',
      composicionRacial: 'Brahman Rojo 100%',
      fechaNacimiento: monthsAgo(20),
      edadMeses: 20,
      categoria: 'Extra',
      pesoActualKg: 540,
      estadoComercial: 'Listo para comercialización',
      estadoProductivo: 'Finalización / Comercialización',
      predioReferencia: 'Predio El Roble (demo)',
      potreroReferencia: 'Potrero 2 (demo)',
    },
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
      gdpGeneralKgDia: gdpGeneral,
      interpretacion: 'Crecimiento sostenido con una desaceleración real entre los 15 y los 18 meses.',
      alerta: 'Desaceleración de crecimiento detectada entre los 15 y los 18 meses (0,67 kg/día, por debajo del promedio esperado de 0,85 kg/día).',
      recomendacion: 'Revisar carga parasitaria y calidad de pastoreo en el potrero asignado.',
      evidenciaRecuperacion: 'Entre los 18 y los 20 meses la ganancia diaria subió a 1,17 kg/día tras el tratamiento antiparasitario aplicado a los 16 meses.',
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
      vinculadoA: 'Alerta de desaceleración de crecimiento (15–18 meses).',
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
        'Tendencia de crecimiento reciente: recuperación confirmada tras la alerta',
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

  return {
    identidad: {
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
    },
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
    sanidad: [
      { evento: 'Aftosa', estado: 'Al día (refuerzo semestral)' },
      { evento: 'Brucelosis', estado: 'Registro histórico de novilla (no se repite en animales adultos)' },
      { evento: 'Desparasitación', estado: 'Periódica, al día' },
    ],
    estadoSanitario: 'Al día, con un evento clínico resuelto',
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
