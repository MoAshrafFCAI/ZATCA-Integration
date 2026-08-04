// config.js
// -----------------------------------------------------------------------------
// Central place for every value this integration needs. Anything marked TODO
// is a placeholder — replace it before pointing this at ZATCA's sandbox or
// production endpoints. Nothing here should be committed to git with real
// secrets in it; use a real .env file (gitignored) or a secrets manager.
// -----------------------------------------------------------------------------

import dotenv from 'dotenv';
dotenv.config();

export const oracleConfig = {
  username: process.env.ORACLE_USERNAME,
  password: process.env.ORACLE_PASSWORD,
  baseUrl: process.env.ORACLE_BASE_URL,
};

export const zatcaConfig = {
  baseUrl: process.env.ZATCA_BASE_URL,
  // TODO: confirm how you actually authenticate to this endpoint.
  // ZATCA's real clearance/reporting APIs authenticate using the compliance/
  // production CSID certificate (as a Basic Auth username) and its associated
  // secret (as the password) — not an arbitrary username/password pair.
  // If you're calling ZATCA directly (not via an internal middleware proxy),
  // this needs to change to certificate-based auth before going live.
  username: process.env.ZATCA_USERNAME,
  password: process.env.ZATCA_PASSWORD,
};

// -----------------------------------------------------------------------------
// TODO: SELLER / VAT INFO
// Replace with your real registered values. Do NOT let this silently fall
// back to a placeholder in production — a missing VAT number should be a
// hard error, not a substituted test value, since submitting a live invoice
// under the wrong VAT number is a compliance problem, not just a bug.
// -----------------------------------------------------------------------------
export const sellerDefaults = {
  vatNumber: process.env.SELLER_VAT_NUMBER || null, // TODO: set real VAT number
  name: process.env.SELLER_NAME || null, // TODO: set real registered name
};

// -----------------------------------------------------------------------------
// TODO: ADDRESSES
// ZATCA requires structured fields: street, buildingNumber (4 digits),
// additionalNumber (4 digits), district, city, postalCode (5 digits),
// countryCode (ISO 3166-1 alpha-2, e.g. "SA").
// Parsing these out of a free-text address string (as the original code did)
// is unreliable. Until Oracle Fusion reliably returns structured fields,
// keep this as an explicit override — or better, look addresses up from your
// own customer/supplier master data keyed by the Oracle party ID.
// -----------------------------------------------------------------------------
export const supplierAddressDefault = {
  street: null, // TODO
  building: null, // TODO
  additionalNumber: null, // TODO
  district: null, // TODO
  city: null, // TODO
  postalCode: null, // TODO
  countryCode: 'SA',
};

// -----------------------------------------------------------------------------
// TODO: CERTIFICATES / KEYS
// Once your CSR and compliance/production CSID are issued by ZATCA, point
// these at the real files. Keep them out of source control (.gitignore).
// -----------------------------------------------------------------------------
export const certPaths = {
  certPath: process.env.ZATCA_CERT_PATH || './certs/cert.pem', // TODO: replace with real cert
  privateKeyPath: process.env.ZATCA_PRIVATE_KEY_PATH || './certs/private-key.pem', // TODO: replace with real key
  // TODO: the certificate signature (QR tag 9) is not just a chunk of the PEM —
  // it's extracted from a specific extension in the certificate ZATCA issues you.
  // Confirm the correct extraction method once your CSID cert exists; the helper
  // in cert-helpers.js has a placeholder you'll need to fill in.
  certSignatureBase64: process.env.ZATCA_CERT_SIGNATURE_B64 || null, // TODO
};

// Extend this if you sell anything other than standard-rated goods/services.
// ZATCA category codes: S = Standard, Z = Zero rated, E = Exempt, O = Out of scope.
export const DEFAULT_TAX_CATEGORY = 'S';

export function assertRequiredConfig() {
  const missing = [];
  if (!sellerDefaults.vatNumber) missing.push('SELLER_VAT_NUMBER');
  if (!sellerDefaults.name) missing.push('SELLER_NAME');
  if (!supplierAddressDefault.street) missing.push('supplierAddressDefault (address fields)');
  if (!certPaths.certSignatureBase64) missing.push('ZATCA_CERT_SIGNATURE_B64');
  if (missing.length) {
    throw new Error(
      `Missing required config before this can run against a real environment: ${missing.join(', ')}. ` +
      `See the TODO comments in config.js.`
    );
  }
}
