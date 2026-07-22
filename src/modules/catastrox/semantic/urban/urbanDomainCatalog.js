// Reutiliza el catalogo semantico ya existente y aprobado (../catastroxSemanticCatalog.js,
// usado hoy por el motor rural/urbano en catastroxDeliverables.js) en vez de duplicar la
// logica de traduccion de dominios. Esta capa solo agrega metadatos de confianza/cobertura
// verificados en auditoria (ver audit_outputs/catastrox/semantic_urban/).
import {
  getDestinoEconomicoDisplay,
  getUsoDisplay,
  getTipoConstruccionDisplay,
  isAmbiguousDestinoEconomico,
} from '../catastroxSemanticCatalog.js';
import { CONFIDENCE_LEVELS } from './urbanQualityRules.js';

// Metadatos de dominio confirmados por auditoria directa de la GDB publica
// (ogrinfo -fielddomain) y por conteo real en catastrox_clean.construcciones/predios.
// No se agregan dominios sin evidencia de auditoria.
export const URBAN_DOMAIN_REGISTRY = {
  domTipoConstruccion: {
    sourceTable: 'U_CONSTRUCCION / catastrox_clean.construcciones',
    sourceField: 'TIPO_CONSTRUCCION',
    verified: true,
    knownValues: ['CONVENCIONAL', 'NO CONVENCIONAL'],
    confidence: CONFIDENCE_LEVELS.ALTA,
    note: 'Dominio nativo de la GDB (ogrinfo -fielddomain domTipoConstruccion). Sin descripcion estructural adicional.',
  },
  CATASTRO_DESTINOS: {
    sourceTable: 'REGISTRO_1 / catastrox_clean.predios',
    sourceField: 'DESTINO_ECONOMICO',
    verified: true,
    knownValues: null,
    confidence: CONFIDENCE_LEVELS.ALTA,
    note: 'Catalogo externo aprobado (codigos_caqueta.csv, fuente Colombia en Mapas). Codigo V bloqueado por ambiguo.',
  },
  CATASTRO_USOS: {
    sourceTable: 'REGISTRO_1 / catastrox_clean.predios',
    sourceField: 'USO_1 / USO_2 / USO_3',
    verified: true,
    knownValues: null,
    confidence: CONFIDENCE_LEVELS.ALTA,
    note: 'Catalogo externo aprobado (codigos_caqueta.csv, fuente Colombia en Mapas). Codigo 0 (no especificado) no aprobado para cliente.',
  },
};

export function getDomainMetadata(domainName) {
  return URBAN_DOMAIN_REGISTRY[domainName] || null;
}

export function domainHasVerifiedCoverage(domainName) {
  return Boolean(URBAN_DOMAIN_REGISTRY[domainName]?.verified);
}

// Re-exporta las funciones de traduccion ya existentes para que el resto de la biblioteca
// urbana las use sin reimplementarlas.
export { getDestinoEconomicoDisplay, getUsoDisplay, getTipoConstruccionDisplay, isAmbiguousDestinoEconomico };
