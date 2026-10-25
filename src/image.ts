// Prepares a screenshot for the vision model: keeps it sharp enough to read small
// text, but under the server's 3 MB limit (and Vercel's 4.5 MB request cap).

const MAX_BYTES = 2.8 * 1024 * 1024;
const PASSTHROUGH_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function encode(bitmap: ImageBitmap, maxSide: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  // JPEG has no transparency; a white background keeps text readable.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process the image.'))), 'image/jpeg', quality)
  );
}

export async function prepareImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    // Most screenshots can go as-is: no re-encoding means no blurred text.
    if (PASSTHROUGH_TYPES.includes(file.type) && file.size <= MAX_BYTES && Math.max(bitmap.width, bitmap.height) <= 2400) {
      return await readAsDataUrl(file);
    }

    for (const [maxSide, quality] of [[2400, 0.9], [2000, 0.85], [1600, 0.8]] as const) {
      const blob = await encode(bitmap, maxSide, quality);
      if (blob.size <= MAX_BYTES) return await readAsDataUrl(blob);
    }
    throw new Error('That screenshot is too large. Try cropping it.');
  } finally {
    bitmap.close();
  }
}
