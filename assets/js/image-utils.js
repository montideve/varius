// assets/js/image-utils.js
// Utilidad para optimizar imágenes en el cliente antes de subirlas.
// Exporta optimizarImagen(file, options) -> Promise<Blob>

export async function optimizarImagen(file, options = {}) {
  const {
    maxWidth = 800,
    maxHeight = 1200,
    quality = 0.85,
    outputType = null // null -> intenta webp, sino image/jpeg
  } = options;

  if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
    throw new Error('El archivo no es una imagen válida.');
  }

  // Crear un imageBitmap si está disponible (más eficiente)
  let image;
  try {
    if (typeof createImageBitmap === 'function') {
      image = await createImageBitmap(file);
    } else {
      // Fallback a Image + objectURL
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      // convertir a canvas a continuación usando img
      image = img;
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    // Si createImageBitmap falla por CORS u otra cosa, fallback a Image
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    image = img;
    URL.revokeObjectURL(url);
  }

  let srcWidth = image.width;
  let srcHeight = image.height;

  // Calcular dimensiones manteniendo proporción y límites
  let targetWidth = srcWidth;
  let targetHeight = srcHeight;

  const widthRatio = maxWidth / srcWidth;
  const heightRatio = maxHeight / srcHeight;
  const ratio = Math.min(1, Math.min(widthRatio, heightRatio));

  targetWidth = Math.round(srcWidth * ratio);
  targetHeight = Math.round(srcHeight * ratio);

  // Canvas para renderizar
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');

  // Pintar fondo blanco si la imagen tiene transparencia (evita fondo negro en JPEG)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  // Si image es ImageBitmap o Image, drawImage funciona
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

  // Determinar tipo de salida: preferir outputType si se pasa, sino intentar webp
  let mimeType = 'image/jpeg';
  if (outputType) {
    mimeType = outputType;
  } else {
    // Detección simple de soporte WebP: usar canvas.toDataURL
    try {
      const data = canvas.toDataURL('image/webp');
      if (data.indexOf('image/webp') === 0) mimeType = 'image/webp';
    } catch (e) {
      mimeType = 'image/jpeg';
    }
  }

  // toBlob promisified
  const blob = await new Promise((resolve) => {
    // quality sólo tiene efecto en image/jpeg y image/webp
    canvas.toBlob((b) => {
      resolve(b);
    }, mimeType, quality);
  });

  // En algunos navegadores toBlob puede devolver null, en tal caso devolver el original como fallback
  if (!blob) return file;

  return blob;
}