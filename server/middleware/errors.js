export function notFound(_req, res) {
  res.status(404).json({ error: 'Ruta no encontrada' });
}

export function errorHandler(error, _req, res, _next) {
  console.error(error);
  res.status(error.status || 500).json({
    error: error.message || 'Error interno del servidor',
  });
}
