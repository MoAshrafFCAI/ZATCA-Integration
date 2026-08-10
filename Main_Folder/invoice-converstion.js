import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DOMParser } from "xmldom";
import { fileURLToPath } from "url";

// ============================================================
// USAGE:  node invoice-converstion.js [input.xml] [outputDir] [previousInvoiceHash]
// DEFAULT: set DEFAULT_INPUT_PATH below and run: node invoice-converstion.js
//
// NOTE ON SCOPE: this produces the UNSIGNED UBL invoice — everything
// in the reference Standard_Invoice.xml except the cryptographic
// signature and QR code inside <ext:UBLExtensions>. Those two blocks
// can only be produced by ZATCA's signing process using your onboarded
// CSID certificate/private key, which is a separate step (normally
// done with @talha7k/zatca's signing function, or the Fatoora SDK)
// run AFTER this file is generated. The <cac:Signature> placeholder
// (just static IDs, no crypto) IS included, matching the reference.
// ============================================================

function resolveInputPath(rawArg) {
  if (!rawArg) return rawArg;
  if (rawArg.startsWith("file://")) return fileURLToPath(rawArg);
  return rawArg;
}
  
const DEFAULT_INPUT_PATH = "F:/INFORABIA/Zatca results/new/zatca_report.xml";
const inputPath = resolveInputPath(process.argv[2] || DEFAULT_INPUT_PATH);
const outputDir = process.argv[3] || ".";
// First invoice in the chain uses the ZATCA-defined zero hash (see your
// reference doc, section 10.5). Pass the previous invoice's hash as the
// 3rd arg for every invoice after the first.
const previousInvoiceHash =
  process.argv[4] ||
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

if (!inputPath) {
  console.error(
    "Set DEFAULT_INPUT_PATH at the top of invoice-converstion.js or pass an input XML path as the first argument.",
  );
  process.exit(1);
}
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

// ============================================================
// READ BI PUBLISHER EXTRACT
// ============================================================

function text(row, tag) {
  return row.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";
}
function num(row, tag) {
  const v = parseFloat(text(row, tag));
  return Number.isFinite(v) ? v : 0;
}

function readRows(xmlPath) {
  const xml = fs.readFileSync(xmlPath, "utf-8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rows = Array.from(doc.getElementsByTagName("G_2"));
  if (!rows.length) throw new Error("No <G_2> rows found in the XML file.");
  return rows;
}

function taxCategory(rawCode, rate) {
  const code = (rawCode || "").toUpperCase();
  if (rate === 0 || code.includes("ZERO")) return "Z";
  if (code.includes("EXEMPT")) return "E";
  if (code.includes("OUT")) return "O";
  return "S";
}

/**
 * Builds the ZATCA KSA-2 invoice transaction code: a strict 7-9 character
 * string NNPNESBCG (BR-KSA-06 / BR-KSA-F-06-C40). This is NOT the human
 * readable invoice type name — it must never come from free text like
 * "Standard Invoice". Only the first two digits are commonly needed
 * (invoice subtype); all other flags default to false/0 unless the source
 * data explicitly indicates otherwise.
 *
 * subtypeCode: "01" = tax invoice (B2B), "02" = simplified invoice (B2C)
 */
function buildInvoiceTransactionCode({
  subtypeCode = "01",
  thirdParty = false,
  nominal = false,
  exports = false,
  summary = false,
  selfBilled = false,
  continuousSupply = false,
  b2g = false,
} = {}) {
  const flag = (b) => (b ? "1" : "0");
  return (
    subtypeCode +
    flag(thirdParty) +
    flag(nominal) +
    flag(exports) +
    flag(summary) +
    flag(selfBilled) +
    flag(continuousSupply) +
    flag(b2g)
  );
}

// Escapes text for safe insertion into XML
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// BUILD INVOICE DATA MODEL FROM ROWS
// ============================================================

function buildInvoiceModel(invoiceNumber, rows, icv) {
  const header = rows[0];

  const lines = rows.map((row, index) => {
    const quantity = num(row, "INVOICED_QUANTITY") || 1;
    const unitPrice = num(row, "UNIT_PRICE");
    const lineNet = num(row, "LINE_NET_AMOUNT") || quantity * unitPrice;
    const rate = num(row, "VAT_RATE_PERCENT");

    let taxAmount = num(row, "VAT_LINE_AMOUNT");
    if (taxAmount === 0 && rate > 0) {
      taxAmount = +(lineNet * (rate / 100)).toFixed(2);
      console.warn(
        `Line ${text(row, "LINE_NUMBER") || index + 1}: VAT_LINE_AMOUNT was 0, recomputed as ${taxAmount} from rate ${rate}%. Check the source SQL.`,
      );
    }

    return {
      id: index + 1,
      quantity,
      unitPrice,
      lineExtensionAmount: lineNet,
      taxAmount,
      itemName: text(row, "ITEM_NAME") || `Item ${index + 1}`,
      taxCategoryId: taxCategory(text(row, "VAT_CATEGORY_CODE"), rate),
      taxPercent: rate,
    };
  });

  const lineExtensionAmount = lines.reduce(
    (s, l) => s + l.lineExtensionAmount,
    0,
  );
  const totalTaxAmount = lines.reduce((s, l) => s + l.taxAmount, 0);
  const taxInclusiveAmount = +(lineExtensionAmount + totalTaxAmount).toFixed(2);
  const prepaidAmount = num(header, "PREPAID_AMOUNT");

  const rawBuyerPostal = text(header, "BUYER_POSTAL_ZONE");
  const buyerPostal = /^\d{4,6}$/.test(rawBuyerPostal)
    ? rawBuyerPostal
    : "00000";
  if (rawBuyerPostal && buyerPostal === "00000") {
    console.warn(
      `Invoice ${invoiceNumber}: BUYER_POSTAL_ZONE value "${rawBuyerPostal}" doesn't look like a postal code, defaulted instead. Check the source SQL join.`,
    );
  }

  const sellerCrn = text(header, "SELLER_CRN");
  if (sellerCrn && !/^\d{10}$/.test(sellerCrn)) {
    console.warn(
      `Invoice ${invoiceNumber}: SELLER_CRN "${sellerCrn}" is not a 10-digit number. ZATCA validates CRN as a checksummed 10-digit commercial registration number (BR-KSA-F-08) - this will likely be rejected. Check the actual CRN registered for this legal entity.`,
    );
  }

  return {
    invoiceNumber,
    uuid: randomUUID(),
    icv,
    issueDate: text(header, "ISSUE_DATE"),
    issueTime: text(header, "ISSUE_TIME") || "00:00:00",
    invoiceTypeCode: text(header, "INVOICE_TYPE_CODE"),
    // KSA-2: structured 7-9 char code, NOT the free-text INVOICE_TYPE_NAME
    // field from the extract. Defaults to a plain standard tax invoice
    // (01 subtype, all flags 0). Override here if your extract needs to
    // signal simplified/export/self-billed/etc. invoices.
    invoiceTypeName: buildInvoiceTransactionCode({ subtypeCode: "01" }),
    currencyCode: text(header, "CURRENCY_CODE") || "SAR",
    deliveryDate:
      text(header, "ACTUAL_DELIVERY_DATE") || text(header, "ISSUE_DATE"),
    paymentMeans: text(header, "PAYMENT_MEANS"),

    supplier: {
      crn: text(header, "SELLER_CRN"),
      street: text(header, "SELLER_STREET"),
      building: text(header, "SELLER_BUILDING_NUMBER"),
      district: text(header, "SELLER_DISTRICT"),
      city: text(header, "SELLER_CITY"),
      postalZone: text(header, "SELLER_POSTAL_ZONE"),
      country: text(header, "SELLER_COUNTRY") || "SA",
      vat: text(header, "SELLER_VAT"),
      name: text(header, "SELLER_NAME"),
    },

    customer: {
      street: text(header, "BUYER_STREET"),
      building: text(header, "BUYER_BUILDING_NUMBER"),
      district: text(header, "BUYER_DISTRICT"),
      city: text(header, "BUYER_CITY"),
      postalZone: buyerPostal,
      country: text(header, "BUYER_COUNTRY") || "SA",
      vat: text(header, "BUYER_VAT"),
      name: text(header, "BUYER_NAME"),
    },

    lineExtensionAmount,
    totalTaxAmount,
    taxInclusiveAmount,
    prepaidAmount,
    payableAmount: +(taxInclusiveAmount - prepaidAmount).toFixed(2),
    // top rate/category used for the document-level tax subtotal
    ratePercent: lines[0]?.taxPercent ?? 15,
    taxCategoryId: lines[0]?.taxCategoryId ?? "S",

    lines,
  };
}

// ============================================================
// RENDER UBL XML (structure/order matches Standard_Invoice.xml)
// ============================================================

function renderInvoiceLine(line, currency) {
  return `    <cac:InvoiceLine>
        <cbc:ID>${line.id}</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">${line.quantity.toFixed(6)}</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="${currency}">${line.lineExtensionAmount.toFixed(2)}</cbc:LineExtensionAmount>
        <cac:TaxTotal>
             <cbc:TaxAmount currencyID="${currency}">${line.taxAmount.toFixed(2)}</cbc:TaxAmount>
             <cbc:RoundingAmount currencyID="${currency}">${(line.lineExtensionAmount + line.taxAmount).toFixed(2)}</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>${esc(line.itemName)}</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>${line.taxCategoryId}</cbc:ID>
                <cbc:Percent>${line.taxPercent.toFixed(2)}</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="${currency}">${line.unitPrice.toFixed(2)}</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>`;
}

function renderInvoiceXml(inv) {
  const c = inv.currencyCode;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
    <!-- <ext:UBLExtensions> intentionally omitted here: per the UBL/ZATCA
         schema it must either be absent, or contain a real, signed
         UBLExtension - an empty/placeholder one fails XSD validation
         (cvc-complex-type.2.4.b). The digital signature + QR are injected
         into this element during the signing step, which requires your
         onboarded ZATCA CSID certificate and is not produced by this script. -->

    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>${esc(inv.invoiceNumber)}</cbc:ID>
    <cbc:UUID>${inv.uuid}</cbc:UUID>
    <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>
    <cbc:IssueTime>${inv.issueTime}</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="${inv.invoiceTypeName}">${inv.invoiceTypeCode}</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>${c}</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>${c}</cbc:TaxCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>${inv.icv}</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:Signature>
      <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
      <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
</cac:Signature><cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyIdentification>
                <cbc:ID schemeID="CRN">${esc(inv.supplier.crn)}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(inv.supplier.street)}</cbc:StreetName>
                <cbc:BuildingNumber>${esc(inv.supplier.building)}</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>${esc(inv.supplier.district)}</cbc:CitySubdivisionName>
                <cbc:CityName>${esc(inv.supplier.city)}</cbc:CityName>
                <cbc:PostalZone>${esc(inv.supplier.postalZone)}</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>${esc(inv.supplier.country)}</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(inv.supplier.vat)}</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${esc(inv.supplier.name)}</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
     <cac:AccountingCustomerParty>
        <cac:Party>
            <cac:PostalAddress>
                <cbc:StreetName>${esc(inv.customer.street)}</cbc:StreetName>
                <cbc:BuildingNumber>${esc(inv.customer.building)}</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>${esc(inv.customer.district)}</cbc:CitySubdivisionName>
                <cbc:CityName>${esc(inv.customer.city)}</cbc:CityName>
                <cbc:PostalZone>${esc(inv.customer.postalZone)}</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>${esc(inv.customer.country)}</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${esc(inv.customer.vat)}</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${esc(inv.customer.name)}</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:Delivery>
        <cbc:ActualDeliveryDate>${inv.deliveryDate}</cbc:ActualDeliveryDate>
    </cac:Delivery>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>${esc(inv.paymentMeans)}</cbc:PaymentMeansCode>
    </cac:PaymentMeans>
    <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
        <cbc:Amount currencyID="${c}">0.00</cbc:Amount>
        <cac:TaxCategory>
            <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">${inv.taxCategoryId}</cbc:ID>
            <cbc:Percent>${inv.ratePercent}</cbc:Percent>
            <cac:TaxScheme>
                <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
            </cac:TaxScheme>
        </cac:TaxCategory>
    </cac:AllowanceCharge>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${c}">${inv.totalTaxAmount.toFixed(2)}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${c}">${inv.totalTaxAmount.toFixed(2)}</cbc:TaxAmount>
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${c}">${inv.lineExtensionAmount.toFixed(2)}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${c}">${inv.totalTaxAmount.toFixed(2)}</cbc:TaxAmount>
             <cac:TaxCategory>
                 <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">${inv.taxCategoryId}</cbc:ID>
                 <cbc:Percent>${inv.ratePercent.toFixed(2)}</cbc:Percent>
                <cac:TaxScheme>
                   <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
                </cac:TaxScheme>
             </cac:TaxCategory>
        </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="${c}">${inv.lineExtensionAmount.toFixed(2)}</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="${c}">${inv.lineExtensionAmount.toFixed(2)}</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="${c}">${inv.taxInclusiveAmount.toFixed(2)}</cbc:TaxInclusiveAmount>
        <cbc:AllowanceTotalAmount currencyID="${c}">0.00</cbc:AllowanceTotalAmount>
        <cbc:PrepaidAmount currencyID="${c}">${inv.prepaidAmount.toFixed(2)}</cbc:PrepaidAmount>
        <cbc:PayableAmount currencyID="${c}">${inv.payableAmount.toFixed(2)}</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>
${inv.lines.map((l) => renderInvoiceLine(l, c)).join("\n")}
</Invoice>`;
}

// ============================================================
// MAIN
// ============================================================

function main() {
  const rows = readRows(inputPath);

  const invoiceGroups = new Map();
  for (const row of rows) {
    const invoiceNumber = text(row, "INVOICE_NUMBER");
    if (!invoiceGroups.has(invoiceNumber)) invoiceGroups.set(invoiceNumber, []);
    invoiceGroups.get(invoiceNumber).push(row);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  let icv = 1;
  for (const [invoiceNumber, invoiceRows] of invoiceGroups) {
    console.log(
      `Building invoice ${invoiceNumber} (${invoiceRows.length} line(s))...`,
    );
    const model = buildInvoiceModel(invoiceNumber, invoiceRows, icv++);
    const xml = renderInvoiceXml(model);

    const outFile = path.join(outputDir, `invoice_${invoiceNumber}.xml`);
    fs.writeFileSync(outFile, xml, "utf-8");
    console.log(`Saved: ${outFile}`);
  }
}

main();
