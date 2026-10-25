// OCR is a fallback, not the main pipeline. It runs only when the vision model
// reports important information it couldn't read (tiny or dense text), and its
// output is merged on the server as supporting evidence; it's never shown to the
// user or sent straight to the writer. Tesseract is loaded on demand, so the
// normal vision path never downloads it.

export async function recognizeText(image: Blob): Promise<string> {
  const { default: Tesseract } = await import('tesseract.js');
  const result = await Tesseract.recognize(image, 'eng');
  return result.data.text.trim();
}
