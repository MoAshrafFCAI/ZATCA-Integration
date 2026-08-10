// report-mapper.js
// -----------------------------------------------------------------------------
// Replaces the AR-REST-based fetch/mapping in invoice-mapper.js. Consumes a
// BI Publisher report XML (data model: __Bahaa_Mohamed_zatca_report_xdm)
// instead of calling Oracle's receivablesInvoices REST resource.
//
// Structure observed from the sample file (zatca_report__5___1_.xml):
//   <DATA_DS><G_2>...flat fields, one <G_2> per invoice LINE...</G_2></DATA_DS>
// Header-level fields (invoice number, seller, buyer, totals) are repeated
// on every <G_2> row for a given invoice — this is a flat/denormalized BI
// report shape, not a nested header/lines structure. Multiple lines for the
// same invoice = multiple sibling <G_2> elements sharing the same
// INVOICE_NUMBER; group by that to reassemble one invoice.
//
// IMPORTANT — issues found in the sample data, not fixed silently here:
//   1. BUYER_STREET / BUYER_DISTRICT look transposed in the sample
//      ("District customer" sits in STREET, "street customer" sits in
//      DISTRICT). Left as-is below — check the report's SQL/column mapping
//      rather than assuming this mapper should swap them back, since that's
//      guessing which side is actually wrong.
//   2. LINE_AMOUNT_INCLUSIVE_VAT in the sample equals LINE_NET_AMOUNT exactly
//      (no VAT added) — this field looks unpopulated/unreliable. This mapper
//      does NOT use it; line tax is derived from VAT_CATEGORY_CODE instead
//      (see TAX_CATEGORY_MAP below).
//   3. No SELLER_ADDITIONAL_NUMBER / BUYER_ADDITIONAL_NUMBER column exists in
//      the report at all, but ZATCA's structured address requires an
//      Additional Number (4 digits) alongside Building Number. Seller's
//      falls back to config.js (sellerDefaults/supplierAddressDefault);
//      buyer's has no fallback source yet — stays null, which is legal for a
//      B2C (SIMPLIFIED) buyer but will fail ZATCA validation for B2B if not
//      fixed at the report level before go-live.
//   4. VAT_CATEGORY_CODE is a custom code ("SUNOU_VAT_15"), not a ZATCA
//      category (S/Z/E/O). Mapped explicitly below — extend the map rather
//      than trying to parse the string, since guessing at code meaning is
//      exactly the kind of mistake we already hit once with xml-c14n.
//   5. No billing-reference field observed for credit/debit notes yet (this
//      sample is invoiceTypeCode 388 = standard invoice). Once you have a
//      credit/debit note sample report, we need to find which column holds
//      the original invoice reference and wire resolveBillingReference() to
//      it — structure is carried over from invoice-mapper.js but not
//      connected to a report field yet.
// -----------------------------------------------------------------------------

import { XMLParser } from 'fast-xml-parser';
import { sellerDefaults, supplierAddressDefault, oracleConfig } from './config.js';
import { getPreviousInvoiceHash, getNextInvoiceCounter, getInvoiceRecord } from './chain-store.js';
import { randomUUID } from 'crypto';

const parser = new XMLParser({
  ignoreAttributes: true,
  // IMPORTANT: do NOT let this auto-convert tag values to numbers.
  // INVOICE_SUBTYPE_CODE ("0100000"), postal codes, VAT numbers, etc. all
  // have meaningful leading zeros or need to stay strings; fast-xml-parser's
  // default numeric coercion silently turns "0100000" into 100000, which
  // then re-stringifies as "100000" and corrupts the B2B/B2C prefix check
  // below. Everything that's genuinely numeric (quantities, prices, amounts)
  // is already explicitly parseFloat'd where it's used.
  parseTagValue: false,
  trimValues: true,
});

// Explicit lookup: custom Oracle VAT category code -> ZATCA category + rate.
// TODO: extend this as you encounter zero-rated/exempt/export codes. Throwing
// on an unmapped code is intentional — silently defaulting to Standard/15%
// would misreport tax on anything that isn't actually standard-rated.
const TAX_CATEGORY_MAP = {
  SUNOU_VAT_15: { zatcaCategory: 'S', percent: 15 },
};

/**
 * Fetch a report's raw XML from BI Publisher's REST report service.
 * TODO: confirm the exact REST path/version for your Fusion instance's BIP
 * service, and the parameter name for filtering by invoice number, against
 * your instance's own REST API catalog (Setup and Maintenance) before relying
 * on this — the path below is the commonly documented one but varies by
 * release.
 */
export async function fetchInvoiceReportXml(invoiceNumber) {
  const url = `${oracleConfig.baseUrl}/xmlpserver/services/rest/v1/reports/TODO_REPORT_PATH`;
  const basicAuth = Buffer.from(`${oracleConfig.username}:${oracleConfig.password}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reportRequest: {
        reportOutputFormat: 'xml',
        parameters: { INVOICE_NUMBER: invoiceNumber }, // TODO: confirm actual parameter name
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`BI Publisher report request failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data.reportBytes) {
    throw new Error('BI Publisher response had no reportBytes field — check reportOutputFormat/parameters.');
  }
  return Buffer.from(data.reportBytes, 'base64').toString('utf8');
}

/**
 * Parse the report's raw XML into an array of flat row objects (one per
 * <G_2>, i.e. one per invoice line).
 */
export function parseReportXml(rawXml) {
  const parsed = parser.parse(rawXml);
  const rows = parsed.DATA_DS?.G_2;
  if (!rows) {
    throw new Error('No <G_2> rows found under <DATA_DS> — check the report XML structure.');
  }
  // fast-xml-parser gives a single object (not an array) when there's only
  // one <G_2> element — normalize to always work with an array.
  return Array.isArray(rows) ? rows : [rows];
}

/**
 * Map parsed report rows (all rows for ONE invoice, already grouped by
 * INVOICE_NUMBER by the caller) into the same ZATCA invoice shape
 * invoice-mapper.js used to produce, so index.js/signing-client.js don't
 * need to change.
 */
export function mapReportRowsToZatcaFormat(rows) {
  if (!rows || rows.length === 0) {
    throw new Error('mapReportRowsToZatcaFormat called with no rows.');
  }
  const header = rows[0]; // header-level fields are repeated on every row; use the first

  const invoiceTypeCode = String(header.INVOICE_TYPE_CODE);
  const invoiceTypeCodeName = String(header.INVOICE_SUBTYPE_CODE);
  const categoryPrefix = invoiceTypeCodeName.slice(0, 2);
  const invoiceCategory = categoryPrefix === '01' ? 'STANDARD' : categoryPrefix === '02' ? 'SIMPLIFIED' : null;
  if (!invoiceCategory) {
    throw new Error(`Unrecognized INVOICE_SUBTYPE_CODE prefix "${categoryPrefix}" in "${invoiceTypeCodeName}".`);
  }

  // Cross-check: STANDARD (B2B) should have a buyer VAT number; SIMPLIFIED
  // (B2C) is allowed not to. Warn rather than throw — the report is the
  // source of truth for category, but a mismatch is worth knowing about.
  const buyerVat = header.BUYER_VAT ? String(header.BUYER_VAT) : null;
  if (invoiceCategory === 'STANDARD' && !buyerVat) {
    console.warn(
      `Invoice ${header.INVOICE_NUMBER}: INVOICE_SUBTYPE_CODE says STANDARD (B2B) but BUYER_VAT is empty — ` +
      `this will likely fail ZATCA validation.`
    );
  }
  if (invoiceCategory === 'SIMPLIFIED' && buyerVat) {
    console.warn(
      `Invoice ${header.INVOICE_NUMBER}: INVOICE_SUBTYPE_CODE says SIMPLIFIED (B2C) but a BUYER_VAT was ` +
      `provided (${buyerVat}) — double check this was actually meant to be a B2C invoice.`
    );
  }

  let lineExtensionAmount = 0;
  let totalTaxAmount = 0;
  const taxBreakdown = new Map();

  const invoiceLines = rows.map((row, index) => {
    const quantity = parseFloat(row.INVOICED_QUANTITY) || 0;
    const unitPrice = parseFloat(row.UNIT_PRICE) || 0;
    const lineAmount = parseFloat(row.LINE_NET_AMOUNT);
    const netAmount = Number.isFinite(lineAmount) ? lineAmount : quantity * unitPrice;

    const categoryCode = row.VAT_CATEGORY_CODE;
    const taxInfo = TAX_CATEGORY_MAP[categoryCode];
    if (!taxInfo) {
      throw new Error(
        `Line ${row.LINE_NUMBER} (invoice ${header.INVOICE_NUMBER}): unmapped VAT_CATEGORY_CODE ` +
        `"${categoryCode}" — add it to TAX_CATEGORY_MAP in report-mapper.js.`
      );
    }
    const lineTaxAmount = Math.round(netAmount * taxInfo.percent) / 100;

    lineExtensionAmount += netAmount;
    totalTaxAmount += lineTaxAmount;

    const bucket = taxBreakdown.get(taxInfo.zatcaCategory) || {
      taxableAmount: 0,
      taxAmount: 0,
      percent: taxInfo.percent,
    };
    bucket.taxableAmount += netAmount;
    bucket.taxAmount += lineTaxAmount;
    taxBreakdown.set(taxInfo.zatcaCategory, bucket);

    return {
      id: index + 1,
      quantity,
      unitCode: 'C62',
      lineExtensionAmount: netAmount,
      taxAmount: lineTaxAmount,
      itemName: row.ITEM_NAME || `Line ${index + 1}`,
      taxCategoryId: taxInfo.zatcaCategory,
      taxPercent: taxInfo.percent,
      priceAmount: unitPrice,
    };
  });

  const taxSubtotals = Array.from(taxBreakdown.entries()).map(([taxCategoryId, v]) => ({
    taxableAmount: v.taxableAmount,
    taxAmount: v.taxAmount,
    percent: v.percent,
    taxCategoryId,
  }));

  // Cross-check computed totals against the report's own header totals —
  // don't silently trust either source if they disagree.
  const reportedTotalVat = parseFloat(header.TOTAL_VAT_AMOUNT);
  if (Number.isFinite(reportedTotalVat) && Math.abs(reportedTotalVat - totalTaxAmount) > 0.01) {
    console.warn(
      `Invoice ${header.INVOICE_NUMBER}: computed VAT (${totalTaxAmount}) doesn't match report's ` +
      `TOTAL_VAT_AMOUNT (${reportedTotalVat}) — using the computed value. Check VAT_CATEGORY_CODE mapping ` +
      `and/or the report's own calculation.`
    );
  }

  const taxInclusiveAmount = lineExtensionAmount + totalTaxAmount;

  const previousInvoiceHash = getPreviousInvoiceHash();
  const invoiceCounterValue = getNextInvoiceCounter();

  const documentType = invoiceTypeCode === '381' ? 'CREDIT_NOTE' : invoiceTypeCode === '383' ? 'DEBIT_NOTE' : 'INVOICE';
  // TODO: no report field identified yet for the original-invoice reference
  // needed on credit/debit notes. Wire this up once a credit/debit note
  // sample is available — see the header comment.
  const billingReference = documentType === 'INVOICE' ? null : null;

  return {
    invoiceNumber: String(header.INVOICE_NUMBER),
    uuid: randomUUID(),
    invoiceCounter: invoiceCounterValue, // NOTE: @talha7k/zatca's InvoiceData type calls this `invoiceCounter`, not `invoiceCounterValue` — using the wrong key here wouldn't crash (it's optional) but would silently omit the ICV from the generated XML, breaking the required hash-chain document reference with no error at all.
    previousInvoiceHash,
    issueDate: String(header.ISSUE_DATE),
    issueTime: String(header.ISSUE_TIME),
    actualDeliveryDate: header.ACTUAL_DELIVERY_DATE ? String(header.ACTUAL_DELIVERY_DATE) : null,
    paymentMeansCode: header.PAYMENT_MEANS ? String(header.PAYMENT_MEANS) : null,
    invoiceTypeCode,
    invoiceTypeCodeName,
    invoiceCategory,
    // Required by @talha7k/zatca's InvoiceData type — this was missing
    // entirely before, which is what actually crashed generateInvoiceXml
    // (escapeXml(undefined).replace(...)).
    profileId: invoiceCategory === 'STANDARD' ? 'clearance:1.0' : 'reporting:1.0',
    currencyCode: header.CURRENCY_CODE || 'SAR',
    documentReferences: [],

    supplier: {
      name: header.SELLER_NAME || sellerDefaults.name,
      nameEn: sellerDefaults.name,
      nameAr: sellerDefaults.nameAr,
      vatNumber: header.SELLER_VAT ? String(header.SELLER_VAT) : sellerDefaults.vatNumber,
      crNumber: header.SELLER_CRN ? String(header.SELLER_CRN) : sellerDefaults.crNumber,
      registrationName: header.SELLER_NAME || sellerDefaults.name,
      address: {
        street: header.SELLER_STREET || supplierAddressDefault.street,
        building: header.SELLER_BUILDING_NUMBER || supplierAddressDefault.building,
        // Report has no additional-number column — always from config for now.
        additionalNumber: supplierAddressDefault.additionalNumber,
        district: header.SELLER_DISTRICT || supplierAddressDefault.district,
        city: header.SELLER_CITY || supplierAddressDefault.city,
        postalCode: header.SELLER_POSTAL_ZONE || supplierAddressDefault.postalCode,
        countryCode: header.SELLER_COUNTRY || supplierAddressDefault.countryCode,
      },
    },

    customer: {
      name: header.BUYER_NAME || 'Unknown Customer',
      nameEn: header.BUYER_NAME || 'Unknown Customer',
      nameAr: header.BUYER_NAME || 'Unknown Customer',
      // @talha7k/zatca's CustomerInfo.vatNumber is a required string, not
      // nullable — '' (not null) for B2C, or generateInvoiceXml crashes the
      // same way the missing profileId did above.
      vatNumber: buyerVat || '',
      registrationName: header.BUYER_NAME || 'Unknown Customer',
      address: {
        street: header.BUYER_STREET || null,
        building: header.BUYER_BUILDING_NUMBER || null,
        additionalNumber: null, // TODO: no report column for this yet
        district: header.BUYER_DISTRICT || null,
        city: header.BUYER_CITY || null,
        postalCode: header.BUYER_POSTAL_ZONE || null,
        countryCode: header.BUYER_COUNTRY || 'SA',
      },
    },

    lineExtensionAmount,
    taxExclusiveAmount: lineExtensionAmount,
    taxInclusiveAmount,
    payableAmount: parseFloat(header.AMOUNT_DUE) || taxInclusiveAmount,
    taxAmount: totalTaxAmount,
    taxSubtotals,
    invoiceLines,

    billingReference,
  };
}

/**
 * Convenience one-shot: raw XML string -> ZATCA invoice objects (plural,
 * since a single report pull could in principle contain more than one
 * invoice's rows — grouped by INVOICE_NUMBER).
 */
export function mapReportXmlToZatcaFormat(rawXml) {
  const rows = parseReportXml(rawXml);
  const byInvoiceNumber = new Map();
  for (const row of rows) {
    const key = String(row.INVOICE_NUMBER);
    if (!byInvoiceNumber.has(key)) byInvoiceNumber.set(key, []);
    byInvoiceNumber.get(key).push(row);
  }
  return Array.from(byInvoiceNumber.values()).map(mapReportRowsToZatcaFormat);
}