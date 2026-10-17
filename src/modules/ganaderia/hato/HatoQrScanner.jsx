// SPRINT-3D11.3 (R1): escáner de cámara adaptado de qr/QrScanner.jsx
// (legacy). Misma experiencia móvil (html5-qrcode, cámara trasera, recuadro
// 250x250), pero entrega el texto leído SIN normalizar: la interpretación
// (token / código legacy / inválido) la hace parseQrContent. No consulta
// ninguna API.
import { Html5Qrcode } from 'html5-qrcode';
import { Camera, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';

const scannerId = 'agx-hato-qr-reader';

export default function HatoQrScanner({ onDecoded }) {
  const scannerRef = useRef(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, []);

  const start = async () => {
    setError('');
    try {
      const scanner = new Html5Qrcode(scannerId);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          await scanner.stop().catch(() => {});
          setActive(false);
          onDecoded(decodedText);
        },
      );
      setActive(true);
    } catch {
      setError('No se pudo acceder a la cámara. Verifica los permisos del navegador.');
    }
  };

  const stop = async () => {
    if (scannerRef.current?.isScanning) {
      await scannerRef.current.stop().catch(() => {});
    }
    setActive(false);
  };

  return (
    <div className="gan-scanner">
      <div id={scannerId} />
      <div className="gan-hato-actions">
        {!active ? (
          <button type="button" className="gan-submit" onClick={start}>
            <Camera className="h-5 w-5" />
            Activar cámara
          </button>
        ) : (
          <button type="button" className="gan-secondary-button" onClick={stop}>
            <Square className="h-5 w-5" />
            Detener cámara
          </button>
        )}
      </div>
      <StatusMessage type="error">{error}</StatusMessage>
    </div>
  );
}
