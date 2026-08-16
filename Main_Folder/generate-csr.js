// generate-csr.js
// -----------------------------------------------------------------------------
// One-off script: generates a CSR + private key pair for ZATCA EGS onboarding
// using @talha7k/zatca's generateCSR(). Run this once per device/environment.
//
// IMPORTANT: run this yourself (don't paste the resulting private key into
// chat, a ticket, or anywhere else). It's written to private-key.pem — keep
// that file safe. It cannot be recovered from ZATCA if lost (see the earlier
// conversation about the orphaned device on the portal — this is exactly
// what happens if this file is lost).
//
// TODO before running for real: `location.street` below is a placeholder —
// the address data we have on file has no street name (see config.js). Fill
// in the real street before generating the CSR you actually submit.
// -----------------------------------------------------------------------------

import { generateCSR } from '@talha7k/zatca';
import fs from 'fs';
import { randomUUID } from 'crypto';

const params = {
  organizationNameAr: 'شركة سمو العقارية',
  organizationNameEn: 'Sumou Real Estate Company',
  vatNumber: '300437621100003',
  crNumber: '2051034841',

  // Common Name: your own label for this device/solution unit. Not
  // validated against anything ZATCA has on file — just needs to be
  // recognizable to you in the EGS unit list.
  commonName: 'SumouZATCA-EGS1',

  // EGS Serial Number: "1-<vendor/solution name>|2-<version>|3-<unique serial>".
  // Part 3 is a UUID generated once per device — regenerate a new one only if
  // building a genuinely new/separate device, not on every CSR renewal for
  // the same device.
  egsSerialNumber: `1-SumouZATCA|2-1.0.0|3-cd7ffbf7-c1c4-44e5-b5e2-acffb76968e4`,

  country: 'SA',
  invoiceType: '1100', 
  businessCategory: 'Real Estate',

  location: {
    city: 'Al Khubar',
    district: 'الريموك',
    street: 'طريق الملك سلمان بن عبدالعزيز', 
    buildingNumber: '6140',
    postalCode: '34423',
  },
};

// Environment: 'simulation' for the Fatoora simulation portal you're on now
// (maps internally to the PREZATCA-Code-Signing cert template ZATCA expects
// there). Switch to 'production' only once you're onboarding for real.
const environment = 'simulation';

const result = generateCSR(params, environment);

fs.writeFileSync('csr.pem', result.csr);
fs.writeFileSync('private-key.pem', result.privateKey);
fs.writeFileSync('public-key.pem', result.publicKey);

console.log('Wrote csr.pem, private-key.pem, public-key.pem');
console.log('CSR (paste this into the Fatoora portal / send as the CSR in the compliance request):');
console.log(result.csr);
