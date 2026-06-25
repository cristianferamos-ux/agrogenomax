import { Download } from 'lucide-react';
import { useState } from 'react';

export default function CatastroXDownloadMock({ label, href, download, onClick }) {
  const [isBusy, setIsBusy] = useState(false);

  const handleAction = async (event) => {
    if (!onClick) return;
    event?.preventDefault?.();
    try {
      setIsBusy(true);
      await onClick();
    } finally {
      setIsBusy(false);
    }
  };

  if (href && !onClick) {
    return (
      <a
        className="catastrox-button is-secondary"
        href={href}
        download={download}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Download size={18} />
        {label}
      </a>
    );
  }

  return (
    <button type="button" className="catastrox-button is-secondary" onClick={handleAction} disabled={isBusy}>
      <Download size={18} />
      {isBusy ? 'Generando...' : label}
    </button>
  );
}
