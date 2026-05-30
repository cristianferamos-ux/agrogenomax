import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import AnimalInitialForm from '../animales/AnimalInitialForm.jsx';
import QrScanner from './QrScanner.jsx';

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

export default function QrEntryPage() {
  const { codigo } = useParams();
  const navigate = useNavigate();
  const [manualCode, setManualCode] = useState(codigo || '');
  const [qrState, setQrState] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const lookup = async (value) => {
    const code = normalizeCode(value);
    if (!code) {
      setError('Ingresa o escanea un código QR.');
      return;
    }

    setLoading(true);
    setError('');
    setQrState(null);

    try {
      const result = await ganaderiaApi.lookupQr(code);
      const animalId = result.animal?.id || result.animal?.animal_id;
      if (result.assigned && animalId) {
        navigate(`/ganaderia/animal/${animalId}`);
        return;
      }
      setQrState({ ...result, codigo: code });
    } catch (err) {
      setError(err.message.includes('404') ? 'QR no registrado en AgroGenomaX' : err.message);
      if (err.message.toLowerCase().includes('not found')) {
        setError('QR no registrado en AgroGenomaX');
      }
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
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Registro de Animales</span>
          <h2>Primero valida el QR</h2>
          <p>No se muestra el formulario animal hasta confirmar que el QR existe y está libre.</p>
        </div>
        <div className="gan-qr-grid">
          <div className="gan-qr-mobile">
            <QrScanner onCode={(code) => lookup(code)} />
          </div>
          <form className="gan-manual-qr" onSubmit={submit}>
            <FormField label="Ingresar código QR">
              <input
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                placeholder="AGX-XXXXXX"
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
        <AnimalInitialForm codigoQr={qrState.codigo} onCreated={(animal) => navigate(`/ganaderia/animal/${animal.id}`)} />
      ) : null}
    </div>
  );
}
