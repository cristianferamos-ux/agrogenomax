export const CATASTROX_STATUS = {
  IDENTIFICADO: 'PREDIO_IDENTIFICADO',
  INCONSISTENCIA: 'INCONSISTENCIA_CARTOGRAFICA',
  FISCAL: 'PREDIO_FISCAL',
  NO_PREDIO_INDIVIDUALIZADO: 'NO_PREDIO_INDIVIDUALIZADO',
  SIN_COBERTURA_CATASTRAL: 'SIN_COBERTURA_CATASTRAL',
  PENDIENTE_VALIDACION: 'PENDIENTE_VALIDACION',
};

export const CATASTROX_CONTACT = {
  whatsappUrl: 'https://wa.me/573000000000',
  email: 'catastrox@agrogenomax.com',
};

export const CATASTROX_LEGAL_NOTICE =
  'CatastroX realiza análisis técnico con información geográfica y catastral pública disponible. No reemplaza certificados oficiales ni decisiones de autoridad competente.';

function buildMockPolygon(vertices) {
  const coordinates = vertices.map(([, lat, lng]) => [Number(lng), Number(lat)]);
  const [firstLng, firstLat] = coordinates[0];

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[...coordinates, [firstLng, firstLat]]],
    },
  };
}

const albaniaVertices = [
  ['V1', '1.331245', '-75.872110'],
  ['V2', '1.332018', '-75.869928'],
  ['V3', '1.329917', '-75.868744'],
  ['V4', '1.328806', '-75.871406'],
];

const chairaInconsistenciaVertices = [
  ['V1', '1.219552', '-74.842103'],
  ['V2', '1.223104', '-74.836510'],
  ['V3', '1.216410', '-74.832881'],
  ['V4', '1.211752', '-74.839640'],
];

const chairaFiscalVertices = [
  ['V1', '1.046320', '-74.652181'],
  ['V2', '1.053118', '-74.643860'],
  ['V3', '1.041224', '-74.637280'],
  ['V4', '1.034552', '-74.648991'],
];

export const catastroxPredios = [
  {
    id: 'albania-demo',
    estado: CATASTROX_STATUS.IDENTIFICADO,
    estadoLabel: 'Predio identificado',
    municipio: 'Albania',
    departamento: 'Caquetá',
    areaHa: 9.16,
    areaM2: 91588.88,
    perimetroM: 1468.75,
    codigoPredial: '180290001000000027001500000000',
    codigoAnterior: '18029000100279015000',
    estadoPredial: 'Predio individualizado en cartografía catastral pública.',
    verificacionPoligono: 'La vista preliminar coincide con la consulta de referencia y permite continuar con el diagnóstico predial.',
    recomendaciones: [
      'Conserve el diagnóstico para trámites, venta o validación interna.',
      'Verifique la información contra la entidad catastral competente antes de un acto jurídico.',
      'Solicite el plano predial si necesita soportar crédito, proyecto o negociación.',
    ],
    vertices: albaniaVertices,
    polygonGeoJson: buildMockPolygon(albaniaVertices),
    linderos: [
      ['Lindero norte', '418.50 m'],
      ['Lindero oriental', '365.20 m'],
      ['Lindero sur', '401.45 m'],
      ['Lindero occidental', '283.60 m'],
    ],
    referencePoint: { lat: 1.331245, lng: -75.87211 },
  },
  {
    id: 'chaira-inconsistencia',
    estado: CATASTROX_STATUS.INCONSISTENCIA,
    estadoLabel: 'Inconsistencia cartográfica',
    municipio: 'Cartagena del Chairá',
    departamento: 'Caquetá',
    areaHa: 48.5,
    areaM2: 485000,
    perimetroM: 3810.2,
    codigoPredial: '180150002000000004812300000000',
    codigoAnterior: '18015000200481230000',
    estadoPredial: 'La delimitación requiere revisión cartográfica.',
    verificacionPoligono: 'La ubicación consultada presenta diferencias entre la referencia de campo y la traza catastral disponible.',
    recomendaciones: [
      'Verifique las coordenadas tomadas en campo.',
      'Contraste linderos con escritura, certificados y soportes técnicos disponibles.',
      'Solicite una revisión técnica antes de iniciar venta, subdivisión o actualización catastral.',
    ],
    vertices: chairaInconsistenciaVertices,
    polygonGeoJson: buildMockPolygon(chairaInconsistenciaVertices),
    linderos: [
      ['Lindero norte', '1088.40 m'],
      ['Lindero oriental', '942.10 m'],
      ['Lindero sur', '1044.65 m'],
      ['Lindero occidental', '736.22 m'],
    ],
    referencePoint: { lat: 1.219552, lng: -74.842103 },
  },
  {
    id: 'chaira-fiscal',
    estado: CATASTROX_STATUS.FISCAL,
    estadoLabel: 'Predio fiscal o sin individualización',
    municipio: 'Cartagena del Chairá',
    departamento: 'Caquetá',
    areaHa: 67,
    areaM2: 670000,
    perimetroM: 4920,
    codigoPredial: 'No disponible en resultado gratuito',
    codigoAnterior: 'No disponible en resultado gratuito',
    estadoPredial: 'Predio fiscal o polígono de mayor extensión sin individualización predial.',
    verificacionPoligono: 'No se identifica delimitación predial individualizada para la ubicación consultada.',
    recomendaciones: [
      'Verificar situación jurídica.',
      'Realizar levantamiento topográfico georreferenciado.',
      'Elaborar plano MAGNA-SIRGAS.',
      'Generar KMZ/KML.',
      'Generar GML cuando aplique.',
      'Solicitar actualización catastral.',
    ],
    vertices: chairaFiscalVertices,
    polygonGeoJson: buildMockPolygon(chairaFiscalVertices),
    linderos: [
      ['Lindero norte', '1320.00 m'],
      ['Lindero oriental', '1180.00 m'],
      ['Lindero sur', '1410.00 m'],
      ['Lindero occidental', '1010.00 m'],
    ],
    referencePoint: { lat: 1.04632, lng: -74.652181 },
  },
];
