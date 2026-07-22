# CatastroX Semantic Catalog

## Objetivo

Este documento protege la integracion ligera de interpretacion semantica IGAC usada por CatastroX para el motor avanzado y el PDF Plus.

No se copio el pipeline historico completo. Se recupero un catalogo versionado, pequeno y auditable para traducir codigos catastrales usados comercialmente.

## Fuente

Catalogo integrado:

- `src/modules/catastrox/semantic/catastroxSemanticCatalog.caqueta.json`

Fuente externa auditada:

- `<RUTA_FUENTE_CAQUETA>\codigos_caqueta.json`

El archivo fuente externo no se copia al repositorio; solo se versiona el catalogo pequeno y auditable usado por la aplicacion.

Origen semantico documentado:

- `CATASTRO_DESTINOS`: Colombia en Mapas / `config?cmd=config`.
- `CATASTRO_USOS`: Colombia en Mapas / `config?cmd=config`.
- `domTipoConstruccion`: dominios GDB detectados.
- `domTipoDominio`: dominios GDB detectados.

## Que interpreta

El helper `src/modules/catastrox/semantic/catastroxSemanticCatalog.js` interpreta:

- destino economico;
- uso principal, secundario y complementario;
- tipo de construccion;
- valores ya enriquecidos que llegan desde `catastrox_clean`.

Ejemplos validados:

- `M` -> `Pecuario`
- `D` -> `Agropecuario`
- `A` -> `Habitacional`
- `1` -> `VIVIENDA HASTA 3 PISOS`
- `2` -> `RAMADAS - COBERTIZOS - CANEYES`
- `CONVENCIONAL` -> `Convencional`
- `NO CONVENCIONAL` -> `No Convencional`

## Codigo V ambiguo

El codigo `V` de destino economico queda bloqueado como valor comercial definitivo.

Debe mostrarse como:

- `Informacion pendiente de validacion`

Nota asociada:

- `El codigo de destino economico requiere validacion porque puede corresponder a mas de una categoria.`

No se debe mostrar al cliente como una categoria definitiva sin validacion adicional.

## Politica de no mostrar codigos crudos

Los codigos crudos de destino o uso no deben exponerse como dato comercial cuando no exista una interpretacion aprobada para cliente.

Si el dato ya llega interpretado desde `catastrox_clean`, por ejemplo `Pecuario`, el helper lo conserva y lo normaliza. Si llega crudo, por ejemplo `M`, el helper lo traduce cuando el catalogo lo permite.

## Veredas

Este catalogo no interpreta veredas.

Motivo:

- La auditoria mostro que algunos valores son nombres legibles, como `Florida Uno`.
- Otros valores son etiquetas catastrales tecnicas, como `26BB`.
- No existe catalogo confiable encontrado para traducir `26BB` a un nombre comun.

La presentacion de veredas sigue a cargo de:

- `src/modules/catastrox/utils/veredaDisplay.js`

Regla vigente:

- `Florida Uno` -> `Vereda: Florida Uno`
- `26BB` -> `Vereda: Informacion no disponible` y `Identificador catastral de vereda: 26BB`

## Uso en PDF Plus

El PDF Plus usa el catalogo durante la normalizacion de entregables:

- destino economico;
- uso principal;
- usos complementarios;
- tipo o resumen de construccion cuando aplica;
- descripcion interna de KML/KMZ.

El catalogo no modifica:

- geometria;
- area;
- perimetro;
- codigos prediales;
- KML/KMZ tecnico pagado;
- logica del lookup gratuito.

## Fuera de alcance

No interpreta ni promete:

- avaluo;
- decisiones juridicas;
- nombres comunes de veredas cuando la fuente solo trae etiqueta tecnica;
- DXF/CAD robusto;
- exactitud topografica;
- certificacion oficial.
