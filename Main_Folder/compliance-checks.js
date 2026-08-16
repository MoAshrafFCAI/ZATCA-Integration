// compliance-checks.js
// -----------------------------------------------------------------------------
// Onboarding step 3: run compliance checks. ZATCA requires you to submit
// sample documents covering all 6 document types through /compliance/invoices
// before it will issue a Production CSID. This script builds, signs, and
// submits all 6 using @talha7k/zatca's compliance helpers.
//
// Prerequisites (from the previous two steps):
//   csr.pem, private-key.pem                  (generate-csr.js)
//   compliance-cert.pem, compliance-secret.txt (request-compliance-csid.js)
//
// Usage:
//   node compliance-checks.js
//
// Same environment-URL caveat as request-compliance-csid.js: the package's
// default 'sandbox' URL is ZATCA's Developer Portal, not the Fatoora
// simulation portal — overridden below.
// -----------------------------------------------------------------------------

import fs from 'fs';
import {
  ComplianceApi,
  signComplianceInvoice,
  DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH,
} from '@talha7k/zatca';
import { sellerDefaults, supplierAddressDefault } from './config.js';

for (const [name, path] of Object.entries({
  'private-key.pem': './private-key.pem',
  'compliance-cert.pem': './compliance-cert.pem',
  'compliance-secret.txt': './compliance-secret.txt',
})) {
  if (!fs.existsSync(path)) {
    console.error(`Missing ${name} — run the earlier onboarding steps first.`);
    process.exit(1);
  }
}

const privateKeyPem = fs.readFileSync('./private-key.pem', 'utf8');
const certificatePem = fs.readFileSync('./compliance-cert.pem', 'utf8');
const secret = fs.readFileSync('./compliance-secret.txt', 'utf8').trim();

// binarySecurityToken for API auth is the compliance cert's own base64 (not
// the PEM text) — ComplianceApi.verifyCompliance expects the credentials
// shape { binarySecurityToken, secret } matching what requestCSID returned.
// Re-derive it from the saved PEM rather than requiring a 4th saved file.
const binarySecurityToken = Buffer.from(
  certificatePem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''),
  'base64'
).toString('base64');
const credentials = { binarySecurityToken, secret };

const api = new ComplianceApi({
  environment: 'sandbox', // irrelevant once sandboxUrl is set explicitly below
  sandboxUrl: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
});

if (supplierAddressDefault.street?.startsWith('TODO')) {
  console.warn(
    'WARNING: supplierAddressDefault.street in config.js is still a TODO placeholder. ' +
    'Compliance checks may pass structurally but this should be fixed before production.'
  );
}

const supplier = {
  nameAr: sellerDefaults.nameAr,
  nameEn: sellerDefaults.name,
  vatNumber: sellerDefaults.vatNumber,
  crNumber: sellerDefaults.crNumber,
  address: {
    street: supplierAddressDefault.street || 'Unknown Street',
    building: supplierAddressDefault.building,
    district: supplierAddressDefault.district,
    city: supplierAddressDefault.city,
    postalCode: supplierAddressDefault.postalCode,
    countryCode: supplierAddressDefault.countryCode,
  },
};

// All 6 ZATCA document types — see the earlier table in README.md. ZATCA
// requires all 6 to pass before issuing a Production CSID.
const CHECK_TYPES = [
  'STANDARD_INVOICE',
  'STANDARD_CREDIT_NOTE',
  'STANDARD_DEBIT_NOTE',
  'SIMPLIFIED_INVOICE',
  'SIMPLIFIED_CREDIT_NOTE',
  'SIMPLIFIED_DEBIT_NOTE',
];

let counter = 1;
let allPassed = true;

for (const checkType of CHECK_TYPES) {
  try {
    const result = signComplianceInvoice({
      checkType,
      supplier,
      privateKeyPem,
      certificatePem,
      previousInvoiceHash: DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH,
      invoiceCounter: counter++,
    });

    const verify = await api.verifyCompliance(
      credentials,
      result.invoiceHash,
      result.uuid,
      result.base64SignedXml
    );

    if (verify.valid) {
      console.log(`PASS  ${checkType}`);
    } else {
      allPassed = false;
      console.log(`FAIL  ${checkType}`);
      verify.messages.forEach((m) => console.log(`      - ${m}`));
    }
  } catch (err) {
    allPassed = false;
    console.log(`ERROR ${checkType}: ${err.message}`);
  }
}

console.log('');
if (allPassed) {
  console.log('All 6 compliance checks passed. You can now request a Production CSID.');
} else {
  console.log('Some checks failed — fix the reported issues and re-run before requesting a Production CSID.');
  process.exitCode = 1;
}
