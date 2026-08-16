// zatca-pipeline.js
// -----------------------------------------------------------------------------
// Only ZATCA submission (clearance/reporting) lives here now.
//
// Canonicalization, hashing, ECDSA signing, and QR generation used to live in
// this file too, built on the npm package `xml-c14n`. That package (last
// published 2013, unmaintained) turned out to only implement Exclusive C14N —
// it does not implement C14N 1.1, the algorithm ZATCA actually requires — so
// that code could never have produced a valid signature. It's been removed
// rather than left in place as a trap. That work now happens in the Java
// zatca-signing-service, which wraps ZATCA's own SDK jar (the reference
// implementation their servers validate against) — see signing-client.js for
// the Node-side HTTP client that calls it, and
// zatca-signing-service/README.md for what was actually verified there.
// -----------------------------------------------------------------------------

import { zatcaConfig } from './config.js';

// =============================
// SUBMIT TO ZATCA
// =============================
export async function submitToZatca({ base64Invoice, invoiceHash, uuid, submissionType = 'CLEARANCE' }) {
  const endpoint = submissionType === 'CLEARANCE' ? '/invoices/clearance/single' : '/invoices/reporting/single';
  const url = `${zatcaConfig.baseUrl}${endpoint}`;
  const basicAuth = Buffer.from(`${zatcaConfig.username}:${zatcaConfig.password}`).toString('base64');

  // TODO: confirm exact required headers against ZATCA's current API spec —
  // typically includes Accept-Version and Accept-Language in addition to auth.
  // TODO: confirm auth scheme — ZATCA's real clearance/reporting endpoints
  // authenticate using the compliance/production CSID certificate as the
  // Basic Auth username and its associated secret as the password, not an
  // arbitrary username/password pair. If you're calling ZATCA directly
  // (not via an internal middleware proxy), zatcaConfig.username/password
  // need to be the CSID + secret, not generic credentials.
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      invoiceHash,
      uuid,
      invoice: base64Invoice, // base64-encoded XML, per ZATCA's documented payload shape
    }),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`ZATCA ${submissionType} submission failed: HTTP ${response.status} — ${text}`);
  }

  return parsed;
}
