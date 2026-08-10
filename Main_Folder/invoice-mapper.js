// invoice-mapper.js
// -----------------------------------------------------------------------------
// Fetches an AR transaction from Oracle Fusion and maps it into the shape
// @talha7k/zatca's generateInvoiceXml expects.
//
// IMPORTANT: I could not verify that the package "@talha7k/zatca" (as opposed
// to the confirmed-real "@talha7k/zatca-qr") actually exists with a
// generateInvoiceXml export. Before relying on this in production, run:
//   npm view @talha7k/zatca
// and inspect its actual exports. If it doesn't resolve, this mapping shape
// will need to change to match whatever UBL-generation approach you end up
// using instead.
// -----------------------------------------------------------------------------

import { oracleConfig, sellerDefaults, supplierAddressDefault, DEFAULT_TAX_CATEGORY } from './config.js';
import { getPreviousInvoiceHash, getNextInvoiceCounter } from './chain-store.js';
import { randomUUID } from 'crypto';

const basicAuth = Buffer.from(`${oracleConfig.username}:${oracleConfig.password}`).toString('base64');

/**
 * Fetch a single AR transaction (invoice) from Oracle Fusion by transaction ID.
 */
export async function getInvoice(transactionId) {
  const url = `${oracleConfig.baseUrl}/receivablesInvoices`;
  const params = {
    onlyData: 'true',
    expand: 'receivablesInvoiceLines.receivablesInvoiceLineTaxLines',
    q: `CustomerTransactionId=${transactionId}`,
  };

  const response = await fetch(`${url}?${new URLSearchParams(params)}`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Oracle Fusion API error fetching invoice ${transactionId}: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.items || data.items.length === 0) {
    throw new Error(`No invoice found for CustomerTransactionId: ${transactionId}`);
  }
  if (data.items.length > 1) {
    // Shouldn't happen given the exact-match query, but fail loudly rather
    // than silently picking items[0] if it ever does.
    throw new Error(`Expected exactly one invoice for CustomerTransactionId ${transactionId}, got ${data.items.length}`);
  }
  return data;
}

/**
 * Map the Oracle Fusion invoice payload into the ZATCA invoice shape.
 *
 * NOTE on addresses: this intentionally does NOT try to parse a free-text
 * address string anymore (the previous version's string-splitting was
 * unreliable and would silently produce wrong ZATCA-required fields).
 * It uses supplierAddressDefault from config.js as an explicit override
 * until you have a reliable structured source. Swap `resolveCustomerAddress`
 * below for a real lookup (e.g. against your own customer master) once ready.
 */
export function mapApiToZatcaFormat(apiData) {
  const invoice = apiData.items[0];
  const apiLines = invoice.receivablesInvoiceLines || [];

  if (apiLines.length === 0) {
    throw new Error(`Invoice ${invoice.TransactionNumber} has no lines — refusing to generate an empty invoice.`);
  }

  const lineExtensionAmount = apiLines.reduce((sum, line) => {
    const quantity = parseFloat(line.Quantity) || 0;
    const unitPrice = parseFloat(line.UnitSellingPrice) || 0;
    return sum + quantity * unitPrice;
  }, 0);

  // Sum actual tax across all lines rather than assuming a single flat rate —
  // the original code only looked at line[0]'s tax line, which breaks the
  // moment an invoice has mixed tax categories.
  let totalTaxAmount = 0;
  const taxBreakdown = new Map(); // taxCategoryId -> { taxableAmount, taxAmount, percent }

  const invoiceLines = apiLines.map((line, index) => {
    const quantity = parseFloat(line.Quantity) || 0;
    const unitPrice = parseFloat(line.UnitSellingPrice) || 0;
    const lineAmount = quantity * unitPrice;

    const taxLine = line.receivablesInvoiceLineTaxLines?.[0];
    const lineTaxAmount = taxLine ? parseFloat(taxLine.TaxAmount) || 0 : 0;
    const lineTaxRate = taxLine ? parseFloat(taxLine.TaxRate) || 0 : 0;
    // TODO: if you sell zero-rated/exempt/export items, map the real Oracle
    // tax classification code to the correct ZATCA category here instead of
    // always defaulting to Standard.
    const taxCategoryId = DEFAULT_TAX_CATEGORY;

    totalTaxAmount += lineTaxAmount;
    const bucket = taxBreakdown.get(taxCategoryId) || { taxableAmount: 0, taxAmount: 0, percent: lineTaxRate };
    bucket.taxableAmount += lineAmount;
    bucket.taxAmount += lineTaxAmount;
    taxBreakdown.set(taxCategoryId, bucket);

    return {
      id: index + 1,
      quantity,
      unitCode: 'C62',
      lineExtensionAmount: lineAmount,
      taxAmount: lineTaxAmount,
      itemName: line.Description || `Line ${index + 1}`,
      taxCategoryId,
      taxPercent: lineTaxRate,
      priceAmount: unitPrice,
    };
  });

  const taxSubtotals = Array.from(taxBreakdown.entries()).map(([taxCategoryId, v]) => ({
    taxableAmount: v.taxableAmount,
    taxAmount: v.taxAmount,
    percent: v.percent,
    taxCategoryId,
  }));

  const taxInclusiveAmount = lineExtensionAmount + totalTaxAmount;

  const transactionDate = invoice.TransactionDate || new Date().toISOString();
  const [datePart, timePartRaw] = transactionDate.split('T');
  const timeMatch = timePartRaw?.match(/^(\d{2}:\d{2}:\d{2})/);
  const issueTime = timeMatch ? timeMatch[1] : '00:00:00';

  // --- VAT numbers: fail loudly instead of silently substituting a sandbox
  // test VAT number, which was the previous behavior.
  const supplierVAT = sellerDefaults.vatNumber;
  const customerVAT = invoice.ShipToCustomerNumber || invoice.BillToCustomerNumber;
  if (!supplierVAT) {
    throw new Error('sellerDefaults.vatNumber is not set — fill this in config.js before generating invoices.');
  }
  if (!customerVAT) {
    throw new Error(`No customer VAT number found on invoice ${invoice.TransactionNumber}.`);
  }

  const supplierName = sellerDefaults.name;
  const customerName = invoice.ShipToCustomerName || invoice.BillToCustomerName || 'Unknown Customer';
  if (!supplierName) {
    throw new Error('sellerDefaults.name is not set — fill this in config.js before generating invoices.');
  }

  const supplierAddress = resolveSupplierAddress();
  const customerAddress = resolveCustomerAddress(invoice);

  // --- Invoice chaining + counter (see chain-store.js) ---
  const previousInvoiceHash = getPreviousInvoiceHash();
  const invoiceCounterValue = getNextInvoiceCounter();

  // TODO: branch invoiceTypeCode/invoiceTypeCodeName + billingReferenceId
  // based on whether this AR transaction is a standard invoice, credit memo
  // (381), or debit memo (383). Currently this only handles standard invoices.
  return {
    invoiceNumber: invoice.TransactionNumber || String(invoice.CustomerTransactionId),
    uuid: randomUUID(),
    invoiceCounterValue,
    previousInvoiceHash,
    issueDate: datePart,
    issueTime,
    invoiceTypeCode: '388',
    invoiceTypeCodeName: '0200000', // TODO: confirm this reflects standard vs simplified correctly for your case
    profileId: 'reporting:1.0',
    currencyCode: invoice.InvoiceCurrencyCode || 'SAR',
    documentReferences: [],

    supplier: {
      name: supplierName,
      nameEn: supplierName,
      nameAr: sellerDefaults.nameAr || supplierName,
      vatNumber: supplierVAT,
      registrationName: supplierName,
      address: supplierAddress,
    },

    customer: {
      name: customerName,
      nameEn: customerName,
      nameAr: customerName, // TODO: populate a real Arabic name if different
      vatNumber: customerVAT,
      registrationName: customerName,
      address: customerAddress,
    },

    lineExtensionAmount,
    taxExclusiveAmount: lineExtensionAmount,
    taxInclusiveAmount,
    payableAmount: taxInclusiveAmount,
    taxAmount: totalTaxAmount,
    taxSubtotals,
    invoiceLines,

    billingReferenceId: null, // TODO: set for credit/debit notes
  };
}

function resolveSupplierAddress() {
  // TODO: replace with your real, confirmed supplier address once available.
  return { ...supplierAddressDefault };
}

function resolveCustomerAddress(invoice) {
  // TODO: replace with a real lookup against customer master data keyed by
  // invoice.BillToCustomerId / ShipToCustomerId. Placeholder shape shown so
  // the rest of the pipeline has something structurally valid to run against.
  return {
    street: null, // TODO
    building: null, // TODO
    additionalNumber: null, // TODO
    district: null, // TODO
    city: invoice.ShipToCity || invoice.BillToCity || null, // TODO: confirm this field name against your instance
    postalCode: null, // TODO
    countryCode: invoice.DefaultTaxationCountry || 'SA',
  };
}