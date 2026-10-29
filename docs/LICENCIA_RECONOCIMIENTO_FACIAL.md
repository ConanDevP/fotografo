# Licencia del reconocimiento facial: cómo resolverla

Estado: **pendiente de decisión**. Última revisión: 29 de octubre de 2026. Esto no es asesoría legal: confirma las condiciones con
InsightFace y con un abogado antes de contar con él.

## El problema

El servicio facial (`python v1/`) carga los modelos de **InsightFace** (`buffalo_l`, ArcFace de 512 dimensiones, detector SCRFD). El código de
InsightFace es MIT, pero **los modelos preentrenados se publican solo para investigación no comercial**. Usarlos en un producto de pago sin licencia
es un incumplimiento y es lo primero que revisaría un comprador o un cliente grande. El cálculo de dorsales con IA (Gemini) y el resto del producto no
dependen de esto: solo la **búsqueda por selfie** y la asociación por rostro.

## Qué usa el sistema hoy

- Servicio: `python v1/app/face_analysis.py` → `insightface.app.FaceAnalysis(name=<insightface_model_name>)`, por defecto `buffalo_l`.
- Salida: 512 valores por rostro, que se guardan en `face_embeddings` (`embedding` y `embedding_vec vector(512)` con índice HNSW de pgvector).
- Consecuencia: **cambiar de modelo obliga a recalcular los vectores de todas las fotografías ya indexadas**, y a validar la precisión de nuevo.

## Opciones

| | A. Licencia comercial de InsightFace | B. Modelos con licencia permisiva (AuraFace + detector propio) | C. Servicio en la nube de reconocimiento |
|---|---|---|---|
| Qué es | Pagar a los autores el derecho de uso comercial de `buffalo_l` | Cambiar el modelo de reconocimiento por uno con licencia Apache 2.0 y reemplazar el detector | Enviar las imágenes a un proveedor (AWS, Azure…) |
| Cambio técnico | **Ninguno** | Medio: nuevo modelo, nuevo detector, recalcular todos los vectores, medir precisión | Alto: reescribir la búsqueda; coste por imagen |
| Riesgo legal | Resuelto con contrato | Menor, pero hay que verificar el detector y el origen de los datos de entrenamiento | Cambia de problema: datos biométricos en un tercero |
| Coste | Desconocido hasta pedir cotización | Tiempo de ingeniería | Por imagen: presiona el margen (hoy la IA cuesta ~$0.0007–0.0015 por foto) |
| Plazo (estimado) | Semanas (negociación) | 1–3 semanas | 2–4 semanas |

### A. Licencia comercial (la vía más rápida y limpia)

InsightFace ofrece licenciar `buffalo_l` y otros paquetes para uso comercial. Su página de licencias pide una descripción del caso de uso,
el volumen esperado de peticiones y el despliegue. **No he visto precios**: hay que pedir cotización. Plantilla del correo al final.

### B. AuraFace (Apache 2.0) con un detector permisivo

- **AuraFace-v1** (fal) es un ResNet100 con pérdida ArcFace, de 512 dimensiones, publicado bajo Apache 2.0 y pensado como alternativa comercial.
  Se carga con la misma API de InsightFace: encaja con el esquema actual (`vector(512)`), no hace falta cambiar la base de datos.
- **Ojo con lo que trae el paquete:** su repositorio incluye también `scrfd_10g_bnkps.onnx`, el **detector de InsightFace**, que según fuentes secundarias
  mantiene la licencia no comercial. Habría que sustituirlo por un detector permisivo (por ejemplo **YuNet**, que las fuentes dan como MIT o Apache 2.0: verifícalo) y revisar el
  `LICENSE.md` del repositorio de fal.
- **Lo que no pude verificar:** de dónde salen los datos de entrenamiento de AuraFace (no los encontré documentados) y cuánta precisión pierde frente a
  `buffalo_l` en fotos de carreras (rostros pequeños, sudor, gorras, movimiento). **Hay que medirlo con fotos reales antes de decidir.**

### C. Servicio en la nube

Resuelve la licencia del modelo pero introduce otras: tratamiento de datos biométricos por un tercero, transferencias internacionales y un coste por imagen
que hoy no tienes. Lo descartaría salvo que A y B fallen.

## Recomendación

Hacer **A y B en paralelo, durante dos semanas**, y decidir con datos:

1. **Esta semana:** escribir a InsightFace pidiendo cotización de licencia comercial para `buffalo_l` (plantilla abajo).
2. **Esta semana:** montar el servicio con AuraFace y un detector permisivo en una rama, **sin tocar producción**, y compararlo con `buffalo_l` sobre un conjunto de
   fotos reales de carreras (200–300 fotos con rostro identificado a mano): porcentaje de selfies que encuentran sus fotos, falsos positivos y tiempo por imagen.
3. **Decisión:** si la cotización es razonable, A (cero cambios y contrato firmado, que es lo que pide un comprador). Si es cara o tarda, B, siempre que la precisión
   sea comparable y el detector y los datos de entrenamiento queden documentados.
4. **Mientras tanto:** no hagas de la búsqueda por selfie el eje de la venta a empresas ni la presentes como "licenciada" ante un cliente grande. La lectura de
   dorsales y el resto de la API no se ven afectados.

## Qué habría que cambiar en el código si se elige B

- `python v1/app/config.py` y `face_analysis.py`: nombre del modelo, carpeta de pesos y detector (`FaceAnalysis` admite elegir los módulos permitidos).
- Reindexar: recalcular `face_embeddings.embedding` y `embedding_vec` de todos los eventos (trabajo de cola; coste de cómputo, no de IA de pago).
- No hay que entrenar nada, pero los umbrales de similitud (`threshold`, asociaciones por rostro) **cambian con el modelo** y deben recalibrarse con el conjunto de prueba.
- Actualizar la política de privacidad si cambia el proveedor del modelo (hoy menciona la extracción de un vector de 512 valores, que seguiría igual).

## Lo que pedirá un comprador o un cliente grande

- Contrato o licencia vigente del modelo de reconocimiento.
- Origen y licencia de los pesos y del detector, por escrito.
- Base legal y consentimiento para datos biométricos (Illinois BIPA, Texas CUBI, Washington y similares): aviso claro antes de la selfie, política de retención
  y borrado, y procedimiento para retirar a una persona del índice. Parte de esto ya está en la política de privacidad; falta la revisión de un abogado de EE. UU.

## Plantilla de correo a InsightFace (en inglés)

> **Subject:** Commercial license request — buffalo_l (race photo search)
>
> Hello,
>
> We run LucilaMon, a US-based platform (LLC) that lets sports photographers and race organizers sell or share event photos. Runners find their photos by bib
> number or by uploading a selfie. We currently use the `buffalo_l` package (ArcFace 512-d embeddings and the SCRFD detector) through the `insightface` Python library
> and would like to license it for commercial use.
>
> - Use case: face matching within a single event; the selfie is not stored; we keep only a 512-d embedding per detected face in the event's photos.
> - Expected volume: _[X] photos per month indexed; [Y] selfie searches per month_ (we are early-stage; please tell us how pricing scales).
> - Deployment: self-hosted inference service on our own infrastructure; customers integrate through our API.
> - Questions: pricing model (flat, per-seat, per-request, revenue share), term, whether the license also covers the SCRFD detector and `antelopev2`, and whether
>   it can be assigned if the company is acquired.
>
> Could you share a quote and the license terms? Thank you.
>
> Christian Rivera — LucilaMon

Antes de enviarlo, completa el volumen y confirma en [insightface.ai](https://www.insightface.ai/services/models-commercial-licensing) la dirección de contacto vigente.
