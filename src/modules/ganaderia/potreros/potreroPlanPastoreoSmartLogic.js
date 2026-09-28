// SPRINT-3D10.4 FASE 4 §33: lógica pura (sin JSX) de PotreroPlanPastoreoSmart.jsx,
// extraída a un módulo aparte para que node --test pueda importarla y
// ejecutarla directamente (node --test no tiene loader de JSX configurado
// -- el resto del repo analiza .jsx solo como texto/regex).
//
// Regla dura (§11 del sprint): buildBodyAuto SOLO incluye hechos
// aportados por el productor -- categoría, peso, fecha, condicionales de
// leche/ternero. NUNCA incluye numeroAnimales ni ningún campo resuelto
// server-side (fichaId/MSU/DI/occupationPolicy/provenance/resultados).
export function buildBodyAuto(categoria, form) {
  const body = {
    categoriaCodigo: categoria.codigo,
    pesoPromedioKg: Number(form.pesoPromedioKg),
    fechaIngresoPrevista: form.fechaIngresoPrevista,
  };
  if (categoria.requiereProduccionLeche) {
    if (form.produccionLecheLDia !== '') body.produccionLecheLDia = Number(form.produccionLecheLDia);
    if (form.grasaLechePct !== '') body.grasaLechePct = Number(form.grasaLechePct);
    if (form.diasEnLeche !== '') body.diasEnLeche = Number(form.diasEnLeche);
  }
  if (categoria.requiereTerneroAlPie) body.terneroAlPie = form.terneroAlPie;
  return body;
}

export function isFormComplete(categoria, form) {
  if (!categoria) return false;
  if (form.pesoPromedioKg === '' || form.fechaIngresoPrevista === '') return false;
  if (categoria.requiereProduccionLeche) {
    if (form.produccionLecheLDia === '') return false;
    if (form.grasaLechePct !== '' && form.diasEnLeche === '') return false;
  }
  return true;
}
