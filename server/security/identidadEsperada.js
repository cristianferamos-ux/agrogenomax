// FASE 4E.1 (extraído en FASE 5A.1b, sin cambios de comportamiento) --
// `identidadEsperada` { cuentaId, organizacionId } opcional en el cuerpo de
// una escritura (la envía el outbox offline): la cuenta que creó la
// operación. Solo se COMPARA con la sesión (req.ganaderiaAuth), que sigue
// siendo la única fuente del tenant y del actor; nunca se usa para escribir.
// Si no coincide, 409 IDENTIDAD_NO_COINCIDE ANTES de la búsqueda idempotente
// y de cualquier escritura. Se monta DESPUÉS del middleware de rol:
// rol -> identidad -> ids -> validación. Un cliente que no lo envía no cambia.
// Lo usan reproducción (eventos, anular, corregir) y pesajes (registrar, anular).

const esTextoDeIdentidad = (valor) => typeof valor === 'string' && valor.length > 0 && valor.length <= 64;

export function requireIdentidadEsperada(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || !Object.hasOwn(req.body, 'identidadEsperada')) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  const { identidadEsperada, ...cuerpo } = req.body;
  const claves = identidadEsperada && typeof identidadEsperada === 'object' ? Object.keys(identidadEsperada) : [];
  if (claves.length !== 2 || !esTextoDeIdentidad(identidadEsperada.cuentaId) || !esTextoDeIdentidad(identidadEsperada.organizacionId)) {
    res.status(400).json({ error: 'INVALID_IDENTIDAD_ESPERADA' });
    return;
  }
  const { cuentaId, organizacionId } = req.ganaderiaAuth;
  if (identidadEsperada.cuentaId !== cuentaId || identidadEsperada.organizacionId !== organizacionId) {
    res.status(409).json({ error: 'IDENTIDAD_NO_COINCIDE', message: 'La operación pertenece a otra cuenta u organización.' });
    return;
  }
  req.body = cuerpo;
  next();
}
