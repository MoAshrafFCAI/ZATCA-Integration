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
// SELLER / VAT INFO
// -----------------------------------------------------------------------------
export const sellerDefaults = {
  vatNumber: process.env.SELLER_VAT_NUMBER || '300437621100003',
  crNumber: process.env.SELLER_CR_NUMBER || '2051034841', // Commercial Registration number — not part of the invoice XML itself, but needed for onboarding/CSR generation later
  name: process.env.SELLER_NAME || 'Sumou Real Estate Company',
  nameAr: process.env.SELLER_NAME_AR || 'شركة سمو العقارية',
};

// -----------------------------------------------------------------------------
// ADDRESSES
// ZATCA requires structured fields: street, buildingNumber (4 digits),
// additionalNumber (4 digits), district, city, postalCode (5 digits),
// countryCode (ISO 3166-1 alpha-2, e.g. "SA").
//
// NOTE on `unitNumber`: ZATCA's standard UBL address block doesn't have a
// dedicated "unit number" field (it has StreetName, BuildingNumber,
// AdditionalStreetName, CitySubdivisionName/district, CityName, PostalZone,
// Country). Unit 22 is kept here so it isn't lost, but TODO: confirm with
// the actual UBL mapping (in invoice-mapper.js / @talha7k/zatca) whether it
// should fold into `additionalStreetName` or just be dropped from the XML —
// it may only matter for your own records, not for ZATCA's schema.
//
// `street` is still unset — the address given didn't include a street name,
// only building/unit/district/city/zip. Fill this in before assertRequiredConfig
// will pass.
// -----------------------------------------------------------------------------
export const supplierAddressDefault = {
  street: null, // TODO: not provided yet — building/district/city alone aren't enough for the required StreetName field
  building: '6140',
  additionalNumber: '4316',
  unitNumber: '22', // see note above — likely not a standard ZATCA field, kept for reference
  district: 'الريموك',
  city: 'Al Khubar',
  postalCode: '34423',
  countryCode: 'SA',
};

// -----------------------------------------------------------------------------
// SIGNING SERVICE
// Canonicalization, hashing, ECDSA signing, and QR generation all happen in
// the Java zatca-signing-service now (see signing-client.js for why) — the
// cert/private key/cert-password env vars live over there
// (zatca-signing-service/.env.example), not here. This is just the URL Node
// calls to reach it.
// -----------------------------------------------------------------------------
export const signingServiceUrl = process.env.ZATCA_SIGNING_SERVICE_URL || 'http://localhost:8080';

// Extend this if you sell anything other than standard-rated goods/services.
// ZATCA category codes: S = Standard, Z = Zero rated, E = Exempt, O = Out of scope.
export const DEFAULT_TAX_CATEGORY = 'S';

export function assertRequiredConfig() {
  const missing = [];
  if (!sellerDefaults.vatNumber) missing.push('SELLER_VAT_NUMBER');
  if (!sellerDefaults.name) missing.push('SELLER_NAME');
  if (!supplierAddressDefault.street) missing.push('supplierAddressDefault (address fields)');
  if (missing.length) {
    throw new Error(
      `Missing required config before this can run against a real environment: ${missing.join(', ')}. ` +
      `See the TODO comments in config.js.`
    );
  }
}