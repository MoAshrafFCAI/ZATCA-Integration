// index.js
// -----------------------------------------------------------------------------
// Full pipeline, wired end to end:
//   Oracle BI Publisher report -> parse report XML -> map to ZATCA shape ->
//   generate UBL XML -> sign (via the Java zatca-signing-service, which
//   handles canonicalization, hashing, ECDSA signing, and QR embedding using
//   ZATCA's own SDK) -> submit -> record chain state
//
// NOTE: this used to fetch from Oracle's receivablesInvoices REST resource
// via invoice-mapper.js. That file is still in the project for reference,
// but is no longer imported here — replaced by report-mapper.js, which
// consumes a BI Publisher report XML instead (see report-mapper.js header
// comment for why, and for the TODOs still open on the BIP REST endpoint
// path/params).
//
// generateInvoiceXml is imported from "@talha7k/zatca" — confirmed real and
// installed; its actual InvoiceData type (checked against
// node_modules/@talha7k/zatca/dist/types.d.ts) is what report-mapper.js's
// output shape is built against.
//
// PREREQUISITE: the Java signing service must be running and reachable at
// ZATCA_SIGNING_SERVICE_URL (default http://localhost:8080) — see
// zatca-signing-service/README.md for setup.
// -----------------------------------------------------------------------------

import { generateInvoiceXml, generateCreditNoteXml } from '@talha7k/zatca';
import fs from 'fs';
import { mapReportXmlToZatcaFormat } from './report-mapper.js';
import { fetchInvoiceReportXml } from './bip-soap-client.js';
import { signInvoiceXml, checkSigningServiceHealth } from './signing-client.js';
import { submitToZatca } from './zatca-pipeline.js';
import { assertRequiredConfig } from './config.js';
import { recordInvoice } from './chain-store.js';

async function generateAndSubmitInvoice(invoiceNumber, { submit = false, submissionType = null } = {}) {
  // Fails loudly and early if VAT number / seller name / address TODOs in
  // config.js haven't been filled in yet.
  assertRequiredConfig();

  if (!(await checkSigningServiceHealth())) {
    throw new Error(
      'ZATCA signing service is not reachable — start it first (see zatca-signing-service/README.md). ' +
      'Nothing was fetched from Oracle yet, so this failed fast on purpose.'
    );
  }

  console.log(`Running BI Publisher report for invoice ${invoiceNumber} (SOAP)...`);
  const rawReportXml = await fetchInvoiceReportXml(invoiceNumber);

  console.log('Mapping report XML to ZATCA format...');
  const invoices = mapReportXmlToZatcaFormat(rawReportXml);
  if (invoices.length !== 1) {
    throw new Error(
      `Expected exactly one invoice for ${invoiceNumber}, got ${invoices.length} — ` +
      `if you're intentionally pulling a multi-invoice report, loop over mapReportXmlToZatcaFormat's ` +
      `result yourself instead of calling generateAndSubmitInvoice per-ID.`
    );
  }
  const invoiceData = invoices[0];

  // Dispatch on document type. @talha7k/zatca has two separate generators:
  // generateCreditNoteXml adds the cac:BillingReference and
  // cbc:InstructionNote blocks that ZATCA requires on 381/383. Passing a
  // credit/debit note through generateInvoiceXml produces XML that looks
  // valid but is missing those blocks, so ZATCA rejects it — and the failure
  // happens at submission, not generation, which makes it hard to trace.
  const isAdjustmentNote = invoiceData.documentType !== 'INVOICE';
  console.log(
    `Generating UBL XML (${invoiceData.documentType}, ${invoiceData.invoiceCategory}, ` +
    `type=${invoiceData.invoiceTypeCode}/${invoiceData.invoiceTypeCodeName})...`
  );
  const ublXml = isAdjustmentNote ? generateCreditNoteXml(invoiceData) : generateInvoiceXml(invoiceData);

  console.log('Signing via zatca-signing-service (canonicalize + hash + sign + QR)...');
  const { invoiceHash, signedInvoiceXml: finalXml } = await signInvoiceXml(ublXml);

  const outFile = `invoice_${invoiceNumber}_final.xml`;
  fs.writeFileSync(outFile, finalXml);
  console.log(`Saved ${outFile}`);

  // B2B (STANDARD) invoices go through /clearance (synchronous — ZATCA signs
  // and hands back a cleared invoice). B2C (SIMPLIFIED) invoices go through
  // /reporting (async, must be reported within 24h of issuance). Callers can
  // still force a specific value via the `submissionType` option, but the
  // default now follows what mapApiToZatcaFormat decided rather than always
  // assuming clearance.
  const resolvedSubmissionType =
    submissionType || (invoiceData.invoiceCategory === 'STANDARD' ? 'CLEARANCE' : 'REPORTING');

  let submissionResult = null;
  if (submit) {
    console.log(`Submitting to ZATCA (${resolvedSubmissionType}, category=${invoiceData.invoiceCategory})...`);
    const base64Invoice = Buffer.from(finalXml, 'utf8').toString('base64');
    submissionResult = await submitToZatca({
      base64Invoice,
      invoiceHash,
      uuid: invoiceData.uuid,
      submissionType: resolvedSubmissionType,
    });
    console.log('Submission result:', submissionResult);

    // Only advance the chain after a confirmed successful submission —
    // recording an invoice that never cleared/reported would corrupt every
    // invoice after it. Also stores uuid/issueDate so a future credit/debit
    // note referencing this invoice can look them up (see chain-store.js).
    recordInvoice(invoiceData.invoiceNumber, invoiceHash, invoiceData.invoiceCounter, {
      uuid: invoiceData.uuid,
      issueDate: invoiceData.issueDate,
      invoiceTypeCode: invoiceData.invoiceTypeCode,
    });
  } else {
    console.log('submit=false — skipping actual ZATCA submission (dry run). Chain state was NOT advanced.');
  }

  return { invoiceData, invoiceHash, finalXml, submissionResult };
}

// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
const invoiceNumber = process.argv[2] || '1000';

generateAndSubmitInvoice(invoiceNumber, { submit: false })
  .then(() => console.log('Done.'))
  .catch((error) => {
    console.error('Failed:', error.message);
    process.exitCode = 1;
  });

export { generateAndSubmitInvoice };