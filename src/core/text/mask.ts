/** Token-like strings, card numbers and long account numbers never reach storage or a model prompt. */
const TOKEN = /[A-Za-z0-9_-]{24,}/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const PHONE = /(?:\+\d{1,3}[ -]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{4}\b/g;
const LONG_NUMBER = /\b\d{8,}\b/g;
const MASK = '[masked]';

export function maskSecrets(text: string): string {
  return text.replace(TOKEN, MASK).replace(CARD, MASK);
}

/**
 * What the "masked" sensitivity promises (core/llm/types.ts): emails, phone numbers and long numbers replaced by
 * code, on top of the secret masking.
 */
export function maskForModel(text: string): string {
  return maskSecrets(text).replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(LONG_NUMBER, MASK);
}
