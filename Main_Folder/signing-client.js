// signing-client.js
// -----------------------------------------------------------------------------
// Thin HTTP client for zatca-signing-service (the Java service that wraps
// ZATCA's real SDK jar). Canonicalization, hashing, ECDSA signing, and QR
// generation now all happen there — not in Node.
//
// Why: the JS pipeline used to do this itself via the `xml-c14n` npm package,
// but that library (last published 2013, unmaintained) only implements
// Exclusive C14N — it does not implement C14N 1.1, which is the algorithm
// ZATCA actually requires. Patching around a missing algorithm isn't
// realistic, so this delegates to the Java service instead, which uses
// ZATCA's own SDK (the reference implementation their servers validate
// against) and was verified end-to-end by actually running it.
//
// Requires the Java service to be running and reachable at
// ZATCA_SIGNING_SERVICE_URL (default http://localhost:8080) — see
// zatca-signing-service/README.md for setup (SDK jar path, cert/key env vars).
// -----------------------------------------------------------------------------

import { signingServiceUrl } from './config.js';

/**
 * Send unsigned UBL invoice XML to the signing service and get back the
 * invoice hash plus the fully signed XML (XAdES signature and QR code
 * already embedded by the SDK — no separate embed step needed on this side).
 */
export async function signInvoiceXml(unsignedUblXml) {
  let response;
  try {
    response = await fetch(`${signingServiceUrl}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: unsignedUblXml,
    });
  } catch (err) {
    throw new Error(
      `Could not reach the ZATCA signing service at ${signingServiceUrl} — ` +
      `is it running? (${err.message})`
    );
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Signing service returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok || !parsed.success) {
    throw new Error(`Signing service failed to sign the invoice (HTTP ${response.status}): ${parsed.error || text}`);
  }

  return {
    invoiceHash: parsed.invoiceHash,
    signedInvoiceXml: Buffer.from(parsed.signedInvoiceXml, 'base64').toString('utf8'),
  };
}

/**
 * Quick reachability check. Call this before a batch run so a down/misconfigured
 * signing service fails fast with a clear message instead of a confusing error
 * mid-invoice.
 */
export async function checkSigningServiceHealth() {
  try {
    const response = await fetch(`${signingServiceUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}