const TECHNICAL_VEREDA_PATTERN = /^\d+[A-Z]{2}$/i;

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function getVeredaDisplay(veredaNombre) {
  const value = cleanText(veredaNombre);

  if (!value) {
    return {
      label: 'Vereda',
      value: 'Información no disponible',
      isCadastralCode: false,
    };
  }

  if (TECHNICAL_VEREDA_PATTERN.test(value)) {
    return {
      label: 'Vereda',
      value: 'Información no disponible',
      secondaryLabel: 'Identificador catastral de vereda',
      secondaryValue: value,
      note: 'La fuente catastral pública consultada no registra un nombre común de vereda para este predio.',
      isCadastralCode: true,
    };
  }

  return {
    label: 'Vereda',
    value,
    isCadastralCode: false,
  };
}
