import { extractLabelFields } from './fields.js';

export { LabelOCR, MODEL_FILES } from './ocr.js';
export { extractLabelFields, casCheckOk, parseDate, similarity } from './fields.js';
export { matchCatalog } from './match.js';

/**
 * One call for the common case: OCR an image and extract label fields.
 * @returns {Promise<{fields, lines, timings}>}
 */
export async function readLabel(ocr, image, opt = {}) {
  const { lines, timings } = await ocr.recognize(image, opt);
  return { fields: extractLabelFields(lines), lines, timings };
}
