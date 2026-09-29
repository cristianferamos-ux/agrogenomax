// SPRINT-3D10.5 F3b: aviso global único de sesión/seguridad/red. Nunca
// redirige ni desmonta contenido por sí mismo -- solo actúa cuando el
// usuario pulsa el CTA. No importa APIs de negocio.
//
// Topología verificada (App.jsx + react-router 7 _renderMatches): todas las
// rutas de Ganadería montan <GanaderiaAuthProvider> en la MISMA posición y
// RenderedRoute se crea sin `key`, así que navegar a /ganaderia/login
// REUTILIZA la instancia del Provider (no relee la sesión). Por eso el CTA
// primero deja el estado local en 'anonymous' (onEndSession) y recién
// después navega: GanaderiaLogin nunca ve un 'authenticated' obsoleto.
import { useNavigate } from 'react-router-dom';
import { AUTH_NOTICE_CTA, getAuthNoticeContent } from './ganaderiaAuthUiModel.js';
import '../styles/ganaderia-auth-notice.css';

export default function GanaderiaAuthNotice({ notice, onDismiss, onEndSession }) {
  const navigate = useNavigate();
  const content = getAuthNoticeContent(notice);
  if (!content) return null;

  function handleCta() {
    if (content.cta === AUTH_NOTICE_CTA.LOGIN) {
      onEndSession();
      navigate('/ganaderia/login', { replace: true });
      return;
    }
    window.location.reload();
  }

  return (
    <div
      className={`gan-auth-notice gan-auth-notice--${notice.toLowerCase()}`}
      role="alert"
      aria-live="assertive"
    >
      <p className="gan-auth-notice-message">{content.message}</p>
      <div className="gan-auth-notice-actions">
        <button type="button" className="gan-auth-notice-cta" onClick={handleCta}>
          {content.ctaLabel}
        </button>
        {content.dismissible ? (
          <button type="button" className="gan-auth-notice-dismiss" onClick={onDismiss}>
            Cerrar
          </button>
        ) : null}
      </div>
    </div>
  );
}
