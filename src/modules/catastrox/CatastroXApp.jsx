import { Navigate, Route, Routes } from 'react-router-dom';
import './styles/catastrox.css';
import CatastroXBasicPage from './pages/CatastroXBasicPage.jsx';
import CatastroXCalculatorPage from './pages/CatastroXCalculatorPage.jsx';
import CatastroXFiscalPage from './pages/CatastroXFiscalPage.jsx';
import CatastroXHomePage from './pages/CatastroXHomePage.jsx';
import CatastroXLayout from './pages/CatastroXLayout.jsx';
import CatastroXPlansPage from './pages/CatastroXPlansPage.jsx';
import CatastroXPlusPage from './pages/CatastroXPlusPage.jsx';
import CatastroXPremiumPage from './pages/CatastroXPremiumPage.jsx';
import CatastroXRegularizationPage from './pages/CatastroXRegularizationPage.jsx';
import CatastroXResultPage from './pages/CatastroXResultPage.jsx';
import CatastroXSearchPage from './pages/CatastroXSearchPage.jsx';
import CatastroXWompiReturnPage from './pages/CatastroXWompiReturnPage.jsx';
import CatastroXWompiVerifyPage from './pages/CatastroXWompiVerifyPage.jsx';

export default function CatastroXApp() {
  return (
    <Routes>
      <Route element={<CatastroXLayout />}>
        <Route index element={<CatastroXHomePage />} />
        <Route path="buscar" element={<CatastroXSearchPage />} />
        <Route path="resultado/:id" element={<CatastroXResultPage />} />
        <Route path="planes" element={<CatastroXPlansPage />} />
        <Route path="basico/:id" element={<CatastroXBasicPage />} />
        <Route path="plus/:id" element={<CatastroXPlusPage />} />
        <Route path="premium/:id" element={<CatastroXPremiumPage />} />
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
