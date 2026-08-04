// CATX-DELIVERY-001-HOTFIX-RAILWAY: copia server-side autosuficiente de
// utilidades de formato/catálogo semántico. Copiado de:
//   src/modules/catastrox/utils/veredaDisplay.js (completo)
//   src/modules/catastrox/semantic/catastroxSemanticCatalog.js (completo)
// El catálogo JSON se copia como hermano de este archivo
// (catastroxSemanticCatalog.caqueta.json) -- ver server/__tests__/architecture/noSrcImports.test.js.

import catalog from './catastroxSemanticCatalog.caqueta.json' with { type: 'json' };

// --- origen: src/modules/catastrox/utils/veredaDisplay.js ---
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

// --- origen: src/modules/catastrox/semantic/catastroxSemanticCatalog.js ---

const AMBIGUOUS_DESTINO_CODES = new Set(['V']);
const EMPTY_VALUES = new Set(['', 'NO DISPONIBLE', 'NO REGISTRA', 'NO ESPECIFICADO', 'NULL', 'UNDEFINED']);

export function normalizeCatalogValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeLookupKey(value) {
  const normalized = normalizeCatalogValue(value);
  if (!normalized) return '';
  const numeric = Number(normalized.replace(',', '.'));
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) {
    return String(numeric);
  }
  return normalized.toUpperCase();
}

function isEmptySemanticValue(value) {
  return EMPTY_VALUES.has(normalizeCatalogValue(value).toUpperCase());
}

function getDomainEntry(domain, value) {
  const key = normalizeLookupKey(value);
  if (!key) return null;
  return catalog.domains?.[domain]?.values?.[key] || null;
}

function formatResult(value, options = {}) {
  return {
    value,
    isAmbiguous: Boolean(options.isAmbiguous),
    isKnown: Boolean(options.isKnown),
    source: options.source || null,
    note: options.note || null,
  };
}

function displayFromDomain(domain, value, fallback = 'Información no disponible') {
  const normalized = normalizeCatalogValue(value);
  if (!normalized || isEmptySemanticValue(normalized)) {
    return formatResult(fallback);
  }

  const entry = getDomainEntry(domain, normalized);
  if (entry?.approvedForClient && entry.label && !isEmptySemanticValue(entry.label)) {
    return formatResult(entry.label, {
      isKnown: true,
      source: domain,
      note: entry.note,
    });
  }

  if (entry && entry.approvedForClient === false) {
    return formatResult(fallback, {
      source: domain,
      note: entry.note,
    });
  }

  return formatResult(normalized, {
    isKnown: true,
    source: 'interpreted_or_enriched_value',
  });
}

export function isAmbiguousDestinoEconomico(code) {
  return AMBIGUOUS_DESTINO_CODES.has(normalizeLookupKey(code));
}

export function getDestinoEconomicoDisplay(codeOrName) {
  if (isAmbiguousDestinoEconomico(codeOrName)) {
    return formatResult('Información pendiente de validación', {
      isAmbiguous: true,
      source: 'CATASTRO_DESTINOS',
      note: 'El código de destino económico requiere validación porque puede corresponder a más de una categoría.',
    });
  }

  return displayFromDomain('CATASTRO_DESTINOS', codeOrName);
}

export function getUsoDisplay(codeOrName) {
  return displayFromDomain('CATASTRO_USOS', codeOrName);
}

export function getTipoConstruccionDisplay(codeOrName) {
  return displayFromDomain('domTipoConstruccion', codeOrName, 'No registra');
}

export function getSafeSemanticLabel(domain, value) {
  if (domain === 'CATASTRO_DESTINOS') return getDestinoEconomicoDisplay(value);
  if (domain === 'CATASTRO_USOS') return getUsoDisplay(value);
  if (domain === 'domTipoConstruccion') return getTipoConstruccionDisplay(value);
  return displayFromDomain(domain, value);
}
