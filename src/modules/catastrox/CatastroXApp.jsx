import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import './styles/catastrox.css';
import CatastroXBasicPage from './pages/CatastroXBasicPage.jsx';
import CatastroXCalculatorPage from './pages/CatastroXCalculatorPage.jsx';
import CatastroXFiscalPage from './pages/CatastroXFiscalPage.jsx';
import CatastroXLayout from './pages/CatastroXLayout.jsx';
import CatastroXPlansPage from './pages/CatastroXPlansPage.jsx';
import CatastroXPlusPage from './pages/CatastroXPlusPage.jsx';
import CatastroXProfessionalPage from './pages/CatastroXProfessionalPage.jsx';
import CatastroXRegularizationPage from './pages/CatastroXRegularizationPage.jsx';
import CatastroXResultPage from './pages/CatastroXResultPage.jsx';
import CatastroXSearchPage from './pages/CatastroXSearchPage.jsx';
import CatastroXWompiReturnPage from './pages/CatastroXWompiReturnPage.jsx';
import CatastroXWompiVerifyPage from './pages/CatastroXWompiVerifyPage.jsx';


function CatastroXLegacyPremiumRedirect() {
  const { id } = useParams();
  const canonicalPath = `/catastrox/profesional/${encodeURIComponent(id || '')}`;
  return <Navigate to={canonicalPath} replace />;
}
export default function CatastroXApp() {
  return (
    <Routes>
      <Route element={<CatastroXLayout />}>
        <Route index element={<CatastroXSearchPage />} />
        <Route path="buscar" element={<Navigate to="/catastrox" replace />} />
        <Route path="resultado/:id" element={<CatastroXResultPage />} />
        <Route path="planes" element={<CatastroXPlansPage />} />
        <Route path="basico/:id" element={<CatastroXBasicPage />} />
        <Route path="plus/:id" element={<CatastroXPlusPage />} />
        <Route
          path="profesional/:id"
          element={<CatastroXProfessionalPage />}
        />
        <Route
          path="premium/:id"
          element={<CatastroXLegacyPremiumRedirect />}
        />
        <Route path="pagos/wompi/retorno" element={<CatastroXWompiReturnPage />} />
        <Route path="pagos/wompi/verificar" element={<CatastroXWompiVerifyPage />} />
        <Route path="predio-fiscal/:id" element={<CatastroXFiscalPage />} />
        <Route path="calculadora" element={<CatastroXCalculatorPage />} />
        <Route path="regularizacion" element={<CatastroXRegularizationPage />} />
        <Route path="*" element={<Navigate to="/catastrox" replace />} />
      </Route>
    </Routes>
  );
}
