export default function CatastroXCommercialTransparency() {
  return (
    <div className="catastrox-transparency-block">
      <p className="catastrox-transparency-note">
        La información catastral utilizada es pública y puede consultarse gratuitamente en el{' '}
        <a href="https://geoportal.igac.gov.co/" target="_blank" rel="noopener noreferrer">
          Geoportal del IGAC
        </a>
        . En CatastroX no pagas por el dato: pagas por su procesamiento, organización y conversión en planos e informes
        listos para consultar y descargar.
      </p>
      <details className="catastrox-transparency-details">
        <summary>¿Por qué pagar por CatastroX?</summary>
        <div>
          <p>
            La información catastral utilizada por CatastroX es pública y puede consultarse gratuitamente en el{' '}
            <a href="https://geoportal.igac.gov.co/" target="_blank" rel="noopener noreferrer">
              Geoportal del IGAC
            </a>
            .
          </p>
          <p>
            Nuestro servicio no vende el dato público. CatastroX lo procesa, organiza y convierte en entregables más
            fáciles de consultar: ficha consolidada, plano predial con coordenadas y distancias, y archivos compatibles
            con Google Earth, GIS o CAD, según el paquete seleccionado.
          </p>
          <p>
            También verificamos la consistencia básica de la información disponible y advertimos cuando un predio requiere
            revisión técnica adicional.
          </p>
          <p>
            Los entregables sirven como apoyo informativo, técnico y comercial. No reemplazan certificados oficiales,
            levantamientos topográficos, estudios de títulos ni decisiones de la autoridad catastral o registral
            competente.
          </p>
        </div>
      </details>
    </div>
  );
}
