export async function onRequest(context) {
  const { request, env } = context;

  const backendBaseUrl = String(
    env.API_BACKEND_URL || 'https://agrogenomax-production.up.railway.app',
  ).replace(/\/+$/, '');

  const incomingUrl = new URL(request.url);
  const targetUrl = `${backendBaseUrl}${incomingUrl.pathname}${incomingUrl.search}`;

  const corsHeaders = {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const headers = new Headers(request.headers);
  headers.delete('host');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  const backendResponse = await fetch(targetUrl, init);
  const responseHeaders = new Headers(backendResponse.headers);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    responseHeaders.set(key, value);
  });

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers: responseHeaders,
  });
}
