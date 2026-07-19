import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
  const [prerequisites, setPrerequisites] = useState({ loading: false, predios: [], potreros: [], error: '' });

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
      console.error('No fue posible validar el QR.', err);
      const safeMessage = err.status === 404 || err.message.includes('404') || err.message.toLowerCase().includes('not found')
        ? 'QR no registrado en AgroGenomaX.'
        : 'No fue posible validar el QR. Intenta nuevamente.';
      setError(safeMessage);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (codigo) lookup(codigo);
  }, [codigo]);

  useEffect(() => {
    let active = true;

    if (!qrState?.exists || qrState.assigned) {
      setPrerequisites({ loading: false, predios: [], potreros: [], error: '' });
      return () => {
        active = false;
      };
    }

    setPrerequisites({ loading: true, predios: [], potreros: [], error: '' });
    Promise.all([ganaderiaApi.listPredios(), ganaderiaApi.listPotreros()])
      .then(([predios, potreros]) => {
        if (!active) return;
        setPrerequisites({
          loading: false,
          predios: Array.isArray(predios) ? predios : [],
          potreros: Array.isArray(potreros) ? potreros : [],
          error: '',
        });
      })
      .catch((err) => {
        console.error('No fue posible validar predios y potreros.', err);
        if (!active) return;
        setPrerequisites({
          loading: false,
          predios: [],
          potreros: [],
          error: 'No fue posible validar los predios y potreros. Intenta nuevamente.',
        });
      });

    return () => {
      active = false;
    };
  }, [qrState]);

  const submit = (event) => {
    event.preventDefault();
    lookup(manualCode);
  };

  return (
    <div className="gan-stack">
      <div className="gan-panel">
        <GanaderiaBackLink to="/ganaderia/dashboard" />
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
        <QrPrerequisiteGate prerequisites={prerequisites}>
          <AnimalInitialForm codigoQr={qrState.codigo} onCreated={(animal) => navigate(`/ganaderia/animal/${animal.id || animal.animal_id}`)} />
        </QrPrerequisiteGate>
      ) : null}
    </div>
  );
}

function QrPrerequisiteGate({ prerequisites, children }) {
  if (prerequisites.loading) {
    return <div className="gan-panel">Validando predios y potreros registrados...</div>;
  }

  if (prerequisites.error) {
    return (
      <div className="gan-panel">
        <StatusMessage type="error">{prerequisites.error}</StatusMessage>
      </div>
    );
  }

  const hasPredios = prerequisites.predios.length > 0;
  const hasPotreros = prerequisites.potreros.length > 0;

  if (!hasPredios) {
    return (
      <PrerequisiteBlock
        title="Primero registra un predio"
        text="Para crear un animal nuevo con este QR, primero debes registrar el predio donde estará ubicado."
        primary={{ label: 'Registrar predio', to: '/ganaderia/predios' }}
      />
    );
  }

  if (!hasPotreros) {
    return (
      <PrerequisiteBlock
        title="Registra al menos un potrero"
        text="Cada animal debe quedar asociado a un potrero dentro del predio."
        primary={{ label: 'Registrar potrero', to: '/ganaderia/potreros' }}
      />
    );
  }

  return (
    <>
      <div className="gan-panel">
        <StatusMessage>
          Requisitos básicos verificados. Completa la información del animal.
        </StatusMessage>
      </div>
      {children}
    </>
  );
}

function PrerequisiteBlock({ title, text, primary }) {
  return (
    <div className="gan-panel">
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Prerrequisito del registro animal</span>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      <StatusMessage>
        Antes de registrar animales, debes registrar el predio con los datos de su propietario y al menos un potrero.
      </StatusMessage>
      <div className="gan-action-row">
        <Link className="gan-secondary-button" to={primary.to}>{primary.label}</Link>
        <Link className="gan-secondary-button" to="/ganaderia/dashboard">Volver al dashboard</Link>
      </div>
    </div>
  );
}
