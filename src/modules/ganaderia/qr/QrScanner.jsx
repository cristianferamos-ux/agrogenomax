import { Html5Qrcode } from 'html5-qrcode';
import { Camera, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { normalizeQrCode } from './normalizeQrCode.js';

const scannerId = 'agx-html5-qr-reader';

export default function QrScanner({ onCode }) {
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
          const code = normalizeQrCode(decodedText);
          await scanner.stop();
          setActive(false);
          onCode(code);
        },
      );
      setActive(true);
    } catch {
      setError('No se pudo acceder a la cámara. Verifica permisos del navegador.');
    }
  };

  const stop = async () => {
    if (scannerRef.current?.isScanning) {
      await scannerRef.current.stop();
    }
    setActive(false);
  };

  return (
    <div className="gan-scanner">
      <div id={scannerId} />
      <div className="gan-action-row">
        {!active ? (
          <button type="button" className="gan-submit" onClick={start}>
            <Camera className="h-5 w-5" />
            Escanear QR
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
