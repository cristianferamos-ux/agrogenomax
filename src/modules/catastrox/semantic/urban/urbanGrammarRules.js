// Reglas gramaticales centralizadas (Fase 5 de la corrección). Toda concordancia
// singular/plural para registros constructivos vive aquí; ningún otro archivo debe
// dispersar condicionales de género/número por su cuenta.

export function pluralizeWord(count, singular, plural) {
  return count === 1 ? singular : plural;
}

// "1 registro constructivo asociado" | "9 registros constructivos asociados"
export function formatRecordCount(count, singularNoun = 'registro constructivo asociado', pluralNoun = 'registros constructivos asociados') {
  return `${count} ${pluralizeWord(count, singularNoun, pluralNoun)}`;
}

// "convencional" | "convencionales", "no convencional" | "no convencionales"
export function pluralizeClassificationLabel(count, base) {
  if (base === 'convencional') return pluralizeWord(count, 'convencional', 'convencionales');
  if (base === 'no convencional') return pluralizeWord(count, 'no convencional', 'no convencionales');
  return base;
}

/**
 * Construye la frase para el caso en que TODOS los registros clasificados caen en una sola
 * categoría (convencional o no convencional), con concordancia singular/plural correcta.
 *
 * count=1 -> "El predio registra un registro constructivo asociado, clasificado como convencional."
 * count>1 -> "De los 20 registros constructivos asociados, 20 están clasificados como convencionales."
 */
export function formatSingleCategorySentence(count, classificationBase) {
  if (count === 1) {
    return `El predio registra un registro constructivo asociado, clasificado como ${classificationBase}.`;
  }
  return `De los ${count} registros constructivos asociados, ${count} están clasificados como ${pluralizeClassificationLabel(count, classificationBase)}.`;
}

// "1 registro no cuenta" | "3 registros no cuentan"
export function formatUnclassifiedClause(count, { adicional = false } = {}) {
  const noun = adicional ? 'registro adicional' : 'registro';
  const nounPlural = adicional ? 'registros adicionales' : 'registros';
  const verb = pluralizeWord(count, 'no cuenta', 'no cuentan');
  return `${count} ${pluralizeWord(count, noun, nounPlural)} ${verb} con clasificación disponible`;
}
