export const ganaderiaPlans = [
  {
    id: 'hato-inicial',
    nombre: 'Plan Hato Inicial',
    rango: 'De 1 a 50 animales',
    activacion: '$999.900',
    mensualidad: '$99.900 / mes',
    chapetas: 50,
    destacado: false,
    animalAdicional: '$2.000 mensual por animal adicional',
    beneficios: [
      'Uso de la plataforma AgroGenomaX Ganadería Inteligente',
      'Servidor en la nube para almacenamiento de datos',
      'Hasta 50 animales registrados',
      '50 chapetas físicas con código QR',
      'QR digitales descargables desde la plataforma',
      'Videos de capacitación',
      'Acceso a módulos de animales, predios, potreros, pesajes, sanidad, reproducción, QR y reportes',
    ],
  },
  {
    id: 'hato-productivo',
    nombre: 'Plan Hato Productivo',
    rango: 'De 51 a 100 animales',
    activacion: '$1.799.900',
    mensualidad: '$159.900 / mes',
    chapetas: 100,
    destacado: false,
    animalAdicional: '$2.000 mensual por animal adicional',
    beneficios: [
      'Todo lo del Plan Hato Inicial',
      'Hasta 100 animales registrados',
      '100 chapetas físicas con código QR',
      'QR digitales descargables',
      'Videos de capacitación',
      'Acceso a módulos de animales, predios, potreros, pesajes, sanidad, reproducción, QR y reportes',
    ],
  },
  {
    id: 'hato-empresarial',
    nombre: 'Plan Hato Empresarial',
    rango: 'De 101 a 300 animales',
    activacion: '$3.899.900',
    mensualidad: '$289.900 / mes',
    chapetas: 300,
    destacado: true,
    badge: 'Más recomendado',
    animalAdicional: '$2.000 mensual por animal adicional',
    capacitacionPresencial: true,
    beneficios: [
      'Todo lo del Plan Hato Productivo',
      'Hasta 300 animales registrados',
      '300 chapetas físicas con código QR',
      'QR digitales descargables',
      'Videos de capacitación',
      'Acceso a módulos de animales, predios, potreros, pesajes, sanidad, reproducción, QR y reportes',
      'Capacitación especializada presencial disponible bajo cotización',
    ],
  },
  {
    id: 'hato-elite',
    nombre: 'Plan Hato Élite',
    rango: 'De 301 a 500 animales',
    activacion: '$5.599.900',
    mensualidad: '$449.900 / mes',
    chapetas: 500,
    destacado: false,
    animalAdicional: '$1.000 mensual por animal adicional',
    capacitacionPresencial: true,
    beneficios: [
      'Todo lo del Plan Hato Empresarial',
      'Hasta 500 animales registrados',
      '500 chapetas físicas con código QR',
      'QR digitales descargables',
      'Videos de capacitación',
      'Acceso a módulos de animales, predios, potreros, pesajes, sanidad, reproducción, QR y reportes',
      'Capacitación especializada presencial y acompañamiento en campo disponible bajo cotización',
    ],
  },
];

export const capacitacionEspecializadaTexto =
  'Disponible bajo cotización personalizada para hatos empresariales que requieran acompañamiento presencial, formación de equipos de trabajo o implementación guiada en campo.';

export const capacitacionCondicionesTexto =
  'La capacitación especializada presencial no está incluida en el valor base del plan. Su costo se cotiza directamente con el cliente según alcance, número de colaboradores, ubicación del predio, desplazamientos, viáticos y requerimientos específicos de implementación.';

export const animalesAdicionalesTexto =
  'Si tu hato supera el límite del plan contratado, puedes registrar animales adicionales sin cambiar inmediatamente de plan. El valor adicional se suma a la mensualidad del plan contratado. La plataforma podrá recomendar el salto al siguiente plan cuando sea más conveniente para el usuario.';

export const chapetasAdicionalesTexto =
  'Cada plan incluye un número inicial de chapetas físicas con código QR. Mientras llegan las chapetas físicas, el usuario puede descargar los QR digitales con su respectivo código alfanumérico para iniciar el registro de animales.';

export const chapetaAdicionalCosto = '$5.000 por chapeta adicional';
export const chapetaPersonalizacionCosto = '$2.000 adicionales por personalización (logo, nombre del predio o distintivo particular)';
export const chapetaPersonalizadaTotal = '$5.000 + $2.000 de personalización = $7.000 por chapeta adicional personalizada';

export const entregaTexto =
  'La activación del plan se realiza con acompañamiento del equipo de AgroGenomaX. El costo de envío se calcula según ciudad de destino.';

export const entregaTiempos = [
  { tipo: 'Chapetas QR normales', principales: '4 a 7 días hábiles', otras: '10 a 15 días hábiles' },
  { tipo: 'Chapetas personalizadas', principales: '12 a 16 días hábiles', otras: '20 a 25 días hábiles' },
];

export const entregaProvisionalTexto =
  'Mientras recibes las chapetas físicas, puedes descargar desde la plataforma los QR digitales con código alfanumérico y registrar tus animales provisionalmente usando la marca de hierro y el número de hierro del animal. Esto facilita identificar cada animal al momento de instalar la chapeta en la oreja.';

export const condicionesComercialesGenerales = [
  'Los valores pueden estar sujetos a actualización comercial.',
  'El costo de envío se liquida según ciudad de destino.',
  'Los animales adicionales se cobran mensualmente.',
  'Las chapetas personalizadas requieren mayor tiempo de producción.',
  'Los QR digitales permiten iniciar la trazabilidad antes de recibir las chapetas físicas.',
  'La información ingresada en la versión demo no corresponde a datos reales de clientes.',
  'La capacitación especializada presencial solo aplica bajo cotización para Hato Empresarial y Hato Élite.',
  'La capacitación presencial depende del alcance, número de colaboradores, ubicación, desplazamientos, viáticos y necesidades específicas del cliente.',
];
