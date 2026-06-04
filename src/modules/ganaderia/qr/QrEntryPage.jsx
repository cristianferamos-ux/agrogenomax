import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AnimalInitialForm from '../animales/AnimalInitialForm.jsx';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { normalizeQrCode } from './normalizeQrCode.js';
import QrScanner from './QrScanner.jsx';

export default function QrEntryPage({ mode = 'manual' }) {
  const { codigo } = useParams();
  const navigate = useNavigate();
  const [manualCode, setManualCode] = useState(codigo || '');
  const [qrState, setQrState] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const lookup = async (value) => {
    const code = normalizeQrCode(value);
    if (!code) {
      setError('Ingresa o escanea un código QR.');
      return;
    }

    setManualCode(code);
    setLoading(true);
    setError('');
    setQrState(null);

    try {
      const result = await ganaderiaApi.lookupQr(code);

      if (!result.exists) {
        setError('QR no registrado en AgroGenomaX.');
        return;
      }

      const animalId = result.animal?.id || result.animal?.animal_id;
      if (result.assigned && animalId) {
        navigate(`/ganaderia/animal/${animalId}`);
        return;
      }

      if (result.assigned && !animalId) {
        setError('QR encontrado y asignado, pero no tiene animal disponible.');
        return;
      }

      setQrState({ ...result, codigo: code });
    } catch (err) {
      const message = err.status === 404 || err.message.includes('404') || err.message.toLowerCase().includes('not found')
        ? 'QR no registrado en AgroGenomaX.'
        : err.message;
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (codigo) lookup(codigo);
  }, [codigo]);

  const submit = (event) => {
    event.preventDefault();
    lookup(manualCode);
  };

  return (
    <div className="gan-stack">
      <div className="gan-panel">
        <GanaderiaBackLink />
        <div className="gan-section-heading">
          <span className="gan-eyebrow">{mode === 'scan' ? 'Escanear QR' : 'Registro de Animales'}</span>
          <h2>{mode === 'scan' ? 'Escanea o ingresa el QR' : 'Primero valida el QR'}</h2>
          <p>No se muestra el formulario animal hasta confirmar que el QR existe y está libre.</p>
        </div>
        <div className={`gan-qr-grid ${mode === 'scan' ? 'is-scan-first' : ''}`}>
          <div className="gan-qr-mobile">
            <QrScanner onCode={(code) => lookup(code)} />
          </div>
          <form className="gan-manual-qr" onSubmit={submit}>
            <FormField label="Ingresar código QR">
              <input
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                placeholder="AGX-000006"
              />
            </FormField>
            <button className="gan-submit" type="submit" disabled={loading}>
              <Search className="h-5 w-5" />
              {loading ? 'Buscando...' : 'Buscar QR'}
            </button>
          </form>
        </div>
        <StatusMessage type="error">{error}</StatusMessage>
      </div>

      {qrState?.exists && !qrState.assigned ? (
        <AnimalInitialForm codigoQr={qrState.codigo} onCreated={(animal) => navigate(`/ganaderia/animal/${animal.id || animal.animal_id}`)} />
      ) : null}
    </div>
  );
}
