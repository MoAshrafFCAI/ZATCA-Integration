// index.js
// -----------------------------------------------------------------------------
// Full pipeline, actually wired together end to end:
//   Oracle Fusion -> map to ZATCA shape -> generate UBL XML -> canonicalize
//   -> hash -> sign -> build QR -> embed -> submit -> record chain state
//
// IMPORTANT: generateInvoiceXml is imported from "@talha7k/zatca", which I
// was NOT able to verify actually exists / exports this function (see the
// note in invoice-mapper.js). Run `npm view @talha7k/zatca` before trusting
// this. If it doesn't resolve, you'll need to swap in whatever UBL-generation
// approach you settle on — everything downstream of `ublXml` doesn't care how
// that XML was produced, just that it matches the invoiceData shape's fields.
// -----------------------------------------------------------------------------

import { generateInvoiceXml } from '@talha7k/zatca';
import fs from 'fs';
import { getInvoice, mapApiToZatcaFormat } from './invoice-mapper.js';
import {
  canonicalizeXml,
  generateInvoiceHash,
  buildSignedInfo,
  signSignedInfo,
  buildSignatureBlock,
  buildQRData,
  extractPublicKeyBase64,
  embedSignatureAndQR,
  submitToZatca,
} from './zatca-pipeline.js';
import { certPaths, assertRequiredConfig } from './config.js';
import { recordInvoice } from './chain-store.js';

async function generateAndSubmitInvoice(customerTransactionId, { submit = false, submissionType = 'CLEARANCE' } = {}) {
  // Fails loudly and early if VAT number / seller name / address / cert
  // signature TODOs in config.js haven't been filled in yet.
  assertRequiredConfig();

  console.log(`Fetching invoice ${customerTransactionId} from Oracle Fusion...`);
  const apiData = await getInvoice(customerTransactionId);

  console.log('Mapping to ZATCA format...');
  const invoiceData = mapApiToZatcaFormat(apiData);

  console.log('Generating UBL XML...');
  const ublXml = generateInvoiceXml(invoiceData);

  console.log('Canonicalizing...');
  const canonicalXml = await canonicalizeXml(ublXml);

  console.log('Hashing...');
  const invoiceHash = generateInvoiceHash(canonicalXml);

  console.log('Signing...');
  // TODO: replace these placeholder files once your CSID cert/key are issued.
  const certPem = fs.readFileSync(certPaths.certPath, 'utf8');
  const privateKeyPem = fs.readFileSync(certPaths.privateKeyPath, 'utf8');

  const signedInfoXml = buildSignedInfo(invoiceHash);
  const signatureBase64 = await signSignedInfo(signedInfoXml, privateKeyPem);
  const signatureBlock = buildSignatureBlock(signedInfoXml, signatureBase64, certPem);

  console.log('Building QR...');
  const publicKeyBase64 = extractPublicKeyBase64(certPem);
  const qrBase64 = buildQRData({
    sellerName: invoiceData.supplier.name,
    vatNumber: invoiceData.supplier.vatNumber,
    timestamp: `${invoiceData.issueDate}T${invoiceData.issueTime}`,
    total: invoiceData.taxInclusiveAmount,
    vatTotal: invoiceData.taxAmount,
    hashBase64: invoiceHash,
    signatureBase64,
    publicKeyBase64,
    certSignatureBase64: certPaths.certSignatureBase64, // TODO: see config.js
  });

  console.log('Embedding signature and QR...');
  const finalXml = embedSignatureAndQR(ublXml, signatureBlock, qrBase64);

  const outFile = `invoice_${customerTransactionId}_final.xml`;
  fs.writeFileSync(outFile, finalXml);
  console.log(`Saved ${outFile}`);

  let submissionResult = null;
  if (submit) {
    console.log(`Submitting to ZATCA (${submissionType})...`);
    const base64Invoice = Buffer.from(finalXml, 'utf8').toString('base64');
    submissionResult = await submitToZatca({
      base64Invoice,
      invoiceHash,
      uuid: invoiceData.uuid,
      submissionType,
    });
    console.log('Submission result:', submissionResult);

    // Only advance the chain after a confirmed successful submission —
    // recording an invoice that never cleared/reported would corrupt every
    // invoice after it.
    recordInvoice(invoiceHash, invoiceData.invoiceCounterValue);
  } else {
    console.log('submit=false — skipping actual ZATCA submission (dry run). Chain state was NOT advanced.');
  }

  return { invoiceData, invoiceHash, finalXml, submissionResult };
}

// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
const customerTransactionId = process.argv[2] || '300000005086439';

generateAndSubmitInvoice(customerTransactionId, { submit: false })
  .then(() => console.log('Done.'))
  .catch((error) => {
    console.error('Failed:', error.message);
    process.exitCode = 1;
  });

export { generateAndSubmitInvoice };
