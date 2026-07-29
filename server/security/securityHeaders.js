// Cabeceras de seguridad HTTP (helmet) para el backend Express de AgroGenomaX.
//
// Este proceso Express nunca sirve el SPA (el frontend se compila con Vite y
// se despliega aparte -- Cloudflare Pages/`functions/`, confirmado en
// index.html: sin rutas de Express que devuelvan HTML de la aplicación,
// solo JSON en `/` y bajo `/api/*`). El widget de Wompi (`checkout.wompi.co`)
// se carga y se embebe desde ESE frontend, no desde este API -- por eso la
// CSP aquí puede ser estricta (`default-src 'none'`) sin necesidad de listar
// dominios de Wompi/Cloudflare: esta API nunca renderiza el iframe/script
// del widget, solo responde JSON que el frontend consume por fetch.
import helmet from 'helmet';

export function createSecurityHeadersMiddleware({ appEnv }) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS solo tiene sentido cuando el tráfico real es HTTPS de punta a
    // punta (producción, detrás de Cloudflare/ALB con TLS terminado ahí).
    // En development/test/demo/staging se omite para no forzar HTTPS en
    // entornos que legítimamente no lo tienen.
    hsts: appEnv === 'production',
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // Permissions-Policy restrictivo por defecto -- helmet@8 no incluye un
    // preset de Permissions-Policy; se añade explícitamente abajo vía
    // header manual si helmet no lo cubre en esta versión (ver
    // createSecurityHeadersMiddleware más abajo).
  });
}

const RESTRICTIVE_PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
].join(', ');

// helmet@8 no gestiona Permissions-Policy (fue retirado de sus defaults en
// versiones recientes) -- se añade como middleware propio, minúsculo,
// siguiendo el mismo estilo hand-rolled que shared/security/corsPolicy.js.
export function createPermissionsPolicyMiddleware() {
  return (_req, res, next) => {
    res.setHeader('Permissions-Policy', RESTRICTIVE_PERMISSIONS_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  };
}
