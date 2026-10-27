/**
 * Proof-of-possession message formats signed by the phone's device key (ES256).
 * The Flutter app must build byte-identical strings.
 */
export const POP_VERSION = 'v1';

export const popMessages = {
  activate: (nonce: string, phoneE164: string): string => `${POP_VERSION}|ACTIVATE|${nonce}|${phoneE164}`,
  refresh: (nonce: string): string => `${POP_VERSION}|REFRESH|${nonce}`,
  pinReset: (nonce: string, phoneE164: string): string => `${POP_VERSION}|PIN_RESET|${nonce}|${phoneE164}`,
  bindingStatus: (nonce: string, bindingId: string): string => `${POP_VERSION}|STATUS|${nonce}|${bindingId}`,
  punch: (nonce: string, intentId: string, selfieSha256: string, lat: number, lng: number): string =>
    `${POP_VERSION}|PUNCH|${nonce}|${intentId}|${selfieSha256}|${lat.toFixed(6)}|${lng.toFixed(6)}`,
} as const;
