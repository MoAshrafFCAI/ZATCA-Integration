// print-csr-json.js
// One-off helper: prints a ready-to-paste JSON body for manually testing
// the /compliance endpoint in Postman (request-compliance-csid.js does this
// automatically — use this only if you want to test in Postman instead).
//
// The "csr" field must be base64 of the ENTIRE PEM text (headers included),
// not the inner CSR body copied out of the PEM file.
import fs from 'fs';
const csrPem = fs.readFileSync('./csr.pem', 'utf8');
const csrBase64 = Buffer.from(csrPem, 'utf8').toString('base64');
console.log(JSON.stringify({ csr: csrBase64 }));
