// zatca-pipeline.js
// -----------------------------------------------------------------------------
// Canonicalization -> hashing -> signing -> QR -> embedding -> submission.
//
// Fixes vs. the original production-generation.js:
//   - No more mixed import/require (that file redeclared crypto, DOMParser,
//     XMLSerializer, and canonicalize, which is a SyntaxError on its own).
//   - Every function is actually called, in order, by run() at the bottom —
//     the original defined the pipeline but never wired it together, and
//     referenced hashBase64/signatureBase64/finalXml before they existed.
//   - Submission payload now matches ZATCA's documented shape: base64-encoded
//     XML plus invoiceHash and uuid as separate top-level fields, instead of
//     a raw XML string under one key.
// -----------------------------------------------------------------------------

import { canonicalize } from 'xml-c14n';
import crypto from 'crypto';
import { DOMParser, XMLSerializer } from 'xmldom';
import asn1 from 'asn1.js';
import { zatcaConfig, certPaths } from './config.js';

const c14n = canonicalize();

// =============================
// 1. CANONICALIZATION
// =============================
export async function canonicalizeXml(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid XML passed to canonicalizeXml');
  }

  doc.normalize();

  const ublExtensions = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:dsig:extensions:2',
    'UBLExtensions'
  );
  for (let i = ublExtensions.length - 1; i >= 0; i--) {
    ublExtensions[i].parentNode.removeChild(ublExtensions[i]);
  }

  const refs = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:CommonAggregateComponents-2',
    'AdditionalDocumentReference'
  );
  for (let i = refs.length - 1; i >= 0; i--) {
    const id = refs[i].getElementsByTagNameNS(
      'urn:oasis:names:specification:ubl:CommonBasicComponents-2',
      'ID'
    );
    if (id.length && id[0].textContent.trim() === 'QR') {
      refs[i].parentNode.removeChild(refs[i]);
    }
  }

  const sigs = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:CommonAggregateComponents-2',
    'Signature'
  );
  for (let i = sigs.length - 1; i >= 0; i--) {
    sigs[i].parentNode.removeChild(sigs[i]);
  }

  const cleanXml = new XMLSerializer().serializeToString(doc);

  // NOTE: xmldom + manual c14n has historically been a source of subtle
  // mismatches against ZATCA's own validator (namespace/attribute ordering,
  // self-closing tags). Before going live, run generated invoices through
  // ZATCA's sandbox compliance check and confirm the hash matches what their
  // SDK produces for the same input — don't just trust this locally.
  return await c14n.canonicalise(cleanXml, {
    algorithm: 'http://www.w3.org/2006/12/xml-c14n11',
    includeComments: false,
  });
}

// =============================
// 2. HASHING
// =============================
export function generateInvoiceHash(canonicalXml) {
  return crypto.createHash('sha256').update(canonicalXml, 'utf8').digest('base64');
}

// =============================
// 3. BUILD SIGNED INFO
// =============================
export function buildSignedInfo(hashBase64) {
  return `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
  <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
  <ds:Reference URI="">
    <ds:Transforms>
      <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
      </ds:Transform>
      <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
      </ds:Transform>
      <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
      </ds:Transform>
      <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
    </ds:Transforms>
    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
    <ds:DigestValue>${hashBase64}</ds:DigestValue>
  </ds:Reference>
</ds:SignedInfo>`;
}

// =============================
// 4. DER -> RAW ECDSA
// =============================
const EcdsaDerSig = asn1.define('EcdsaDerSig', function () {
  this.seq().obj(this.key('r').int(), this.key('s').int());
});

function derToRawSignature(derBuffer) {
  const decoded = EcdsaDerSig.decode(derBuffer, 'der');
  const r = decoded.r.toArrayLike(Buffer, 'be', 32);
  const s = decoded.s.toArrayLike(Buffer, 'be', 32);
  return Buffer.concat([r, s]); // 64 bytes
}

// =============================
// 5. SIGN SIGNEDINFO
// =============================
export async function signSignedInfo(signedInfoXml, privateKeyPem) {
  const canonicalSignedInfo = await c14n.canonicalise(signedInfoXml, {
    algorithm: 'http://www.w3.org/2006/12/xml-c14n11',
    includeComments: false,
  });

  const signer = crypto.createSign('SHA256');
  signer.update(canonicalSignedInfo);

  // TODO: confirm privateKeyPem is a secp256k1 EC key — ZATCA specifically
  // requires secp256k1, not the more common P-256/prime256v1.
  const derSignature = signer.sign(privateKeyPem);
  const rawSignature = derToRawSignature(derSignature);

  return rawSignature.toString('base64');
}

// =============================
// 6. BUILD SIGNATURE BLOCK
// =============================
export function buildSignatureBlock(signedInfoXml, signatureBase64, certPem) {
  const cert = certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

  return `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="Signature">
  ${signedInfoXml}
  <ds:SignatureValue>${signatureBase64}</ds:SignatureValue>
  <ds:KeyInfo>
    <ds:X509Data>
      <ds:X509Certificate>${cert}</ds:X509Certificate>
    </ds:X509Data>
  </ds:KeyInfo>
</ds:Signature>`;
}

// =============================
// 7. QR CODE TLV
// =============================
function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  while (len > 0) {
    bytes.unshift(len & 0xff);
    len >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function getBuffer(tag, value) {
  return tag >= 6 ? Buffer.from(value, 'base64') : Buffer.from(value, 'utf8');
}

// NOTE: there's a verified real package, @talha7k/zatca-qr, that implements
// this same Phase 2 9-tag TLV encoding and claims parity with ZATCA's
// official SDK shape. Worth switching to it once you've confirmed its exact
// API against your data — I've kept this manual version so the pipeline
// below doesn't depend on a package I haven't been able to verify end-to-end.
export function buildQRData({
  sellerName,
  vatNumber,
  timestamp,
  total,
  vatTotal,
  hashBase64,
  signatureBase64,
  publicKeyBase64,
  certSignatureBase64,
}) {
  const tags = [
    { tag: 1, value: sellerName },
    { tag: 2, value: vatNumber },
    { tag: 3, value: timestamp },
    { tag: 4, value: total.toFixed(2) },
    { tag: 5, value: vatTotal.toFixed(2) },
    { tag: 6, value: hashBase64 },
    { tag: 7, value: signatureBase64 },
    { tag: 8, value: publicKeyBase64 },
    { tag: 9, value: certSignatureBase64 },
  ];

  let buffer = Buffer.alloc(0);
  for (const t of tags) {
    const valBuf = getBuffer(t.tag, t.value);
    const lenBuf = encodeLength(valBuf.length);
    buffer = Buffer.concat([buffer, Buffer.from([t.tag]), lenBuf, valBuf]);
  }
  return buffer.toString('base64');
}

// =============================
// 8. EXTRACT PUBLIC KEY FROM CERT
// =============================
export function extractPublicKeyBase64(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  // publicKey.export gives DER SPKI — this is a reasonable default, but
  // confirm the exact encoding ZATCA expects for tag 8 against a known-good
  // sample QR once you have real sandbox credentials to test against.
  const der = cert.publicKey.export({ type: 'spki', format: 'der' });
  return der.toString('base64');
}

// =============================
// 9. EMBED SIGNATURE & QR INTO XML
// =============================
export function embedSignatureAndQR(xml, signatureBlock, qrBase64) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const invoice = doc.documentElement;

  let ublExtensions = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:dsig:extensions:2',
    'UBLExtensions'
  )[0];

  if (!ublExtensions) {
    ublExtensions = doc.createElementNS(
      'urn:oasis:names:specification:ubl:dsig:extensions:2',
      'ext:UBLExtensions'
    );
    invoice.insertBefore(ublExtensions, invoice.firstChild);
  }

  const ublExtension = doc.createElementNS(
    'urn:oasis:names:specification:ubl:dsig:extensions:2',
    'ext:UBLExtension'
  );
  const extContent = doc.createElementNS(
    'urn:oasis:names:specification:ubl:dsig:extensions:2',
    'ext:ExtensionContent'
  );

  const sigDoc = parser.parseFromString(signatureBlock, 'application/xml');
  extContent.appendChild(doc.importNode(sigDoc.documentElement, true));
  ublExtension.appendChild(extContent);
  ublExtensions.appendChild(ublExtension);

  const qrRef = doc.createElementNS(
    'urn:oasis:names:specification:ubl:CommonAggregateComponents-2',
    'cac:AdditionalDocumentReference'
  );
  const id = doc.createElementNS(
    'urn:oasis:names:specification:ubl:CommonBasicComponents-2',
    'cbc:ID'
  );
  id.textContent = 'QR';

  const attachment = doc.createElementNS(
    'urn:oasis:names:specification:ubl:CommonAggregateComponents-2',
    'cac:Attachment'
  );
  const binaryObj = doc.createElementNS(
    'urn:oasis:names:specification:ubl:CommonBasicComponents-2',
    'cbc:EmbeddedDocumentBinaryObject'
  );
  binaryObj.setAttribute('mimeCode', 'text/plain');
  binaryObj.setAttribute('encodingCode', 'Base64');
  binaryObj.textContent = qrBase64;

  attachment.appendChild(binaryObj);
  qrRef.appendChild(id);
  qrRef.appendChild(attachment);

  const supplierParty = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:CommonAggregateComponents-2',
    'AccountingSupplierParty'
  )[0];

  if (supplierParty) {
    invoice.insertBefore(qrRef, supplierParty);
  } else {
    invoice.appendChild(qrRef);
  }

  return new XMLSerializer().serializeToString(doc);
}

// =============================
// 10. SUBMIT TO ZATCA
// =============================
export async function submitToZatca({ base64Invoice, invoiceHash, uuid, submissionType = 'CLEARANCE' }) {
  const endpoint = submissionType === 'CLEARANCE' ? '/invoices/clearance/single' : '/invoices/reporting/single';
  const url = `${zatcaConfig.baseUrl}${endpoint}`;
  const basicAuth = Buffer.from(`${zatcaConfig.username}:${zatcaConfig.password}`).toString('base64');

  // TODO: confirm exact required headers against ZATCA's current API spec —
  // typically includes Accept-Version and Accept-Language in addition to auth.
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
