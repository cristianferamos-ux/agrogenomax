export function onRequest() {
  return new Response(
    JSON.stringify({
      error: 'Not Found',
      code: 'API_ROUTE_NOT_FOUND',
    }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}
