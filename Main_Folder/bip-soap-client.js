// bip-soap-client.js
// -----------------------------------------------------------------------------
// Oracle BI Publisher SOAP client — runs a BIP report synchronously and
// returns its raw XML output.
//
// Uses ExternalReportWSSService / runReport, which is Oracle's documented
// service for running a Fusion BIP report synchronously and getting the
// output back as a base64-encoded string in the SOAP response.
//
//   WSDL:     https://<fusion-host>/xmlpserver/services/ExternalReportWSSService?wsdl
//   Endpoint: https://<fusion-host>/xmlpserver/services/ExternalReportWSSService
//   Operation: runReport
//   Auth:      HTTP Basic (this service also supports JWT bearer; Basic is
//              used here to match the credentials you already have)
//
// Two details that are easy to get wrong and produce confusing results:
//
//   1. attributeFormat MUST be "xml". If it's csv/pdf/etc you'll get output
//      that parseReportXml() can't read.
//   2. flattenXML MUST be "false" for XML output. When true, BIP flattens the
//      data structure and you lose the <G_2> grouping that report-mapper.js
//      relies on to reassemble invoice lines. This is the single most common
//      cause of "the report works in the BIP UI but my parser sees nothing".
//
// NOTE on why this is hand-rolled rather than using a SOAP library: the
// request is one fixed envelope shape with a handful of substituted values,
// and the response only needs one element pulled out of it. Pulling in a
// full WSDL-parsing SOAP client for that would add a dependency (and a
// WSDL-fetch round trip at startup) for no real benefit.
// -----------------------------------------------------------------------------

import { XMLParser } from 'fast-xml-parser';
import { oracleConfig, bipConfig } from './config.js';

// Minimal escaping for values interpolated into the SOAP envelope. Report
// paths and parameter values are ours, not user input, but an unescaped &
// in a path would still silently corrupt the envelope.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the runReport SOAP envelope.
 *
 * @param {string} reportAbsolutePath - full BIP catalog path, ending in .xdo
 *   e.g. "/Custom/Financials/ZATCA/zatca_report.xdo"
 * @param {Object<string,string|number>} parameters - BIP report parameter
 *   name/value pairs. Names must match the report's own parameter names
 *   exactly (case-sensitive).
 */
function buildRunReportEnvelope(reportAbsolutePath, parameters = {}) {
  const parameterItems = Object.entries(parameters)
    .map(
      ([name, value]) =>
        `        <pub:item>
          <pub:name>${escapeXml(name)}</pub:name>
          <pub:values>
            <pub:item>${escapeXml(value)}</pub:item>
          </pub:values>
        </pub:item>`
    )
    .join('\n');

  return `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:pub="http://xmlns.oracle.com/oxp/service/PublicReportService">
  <soap:Header/>
  <soap:Body>
    <pub:runReport>
      <pub:reportRequest>
        <pub:reportAbsolutePath>${escapeXml(reportAbsolutePath)}</pub:reportAbsolutePath>
        <pub:attributeFormat>xml</pub:attributeFormat>
        <!-- Must stay false: true flattens away the <G_2> grouping the parser needs. -->
        <pub:flattenXML>false</pub:flattenXML>
        <pub:parameterNameValues>
${parameterItems}
        </pub:parameterNameValues>
        <!-- -1 = return the whole document in one response rather than chunking. -->
        <pub:sizeOfDataChunkDownload>-1</pub:sizeOfDataChunkDownload>
      </pub:reportRequest>
    </pub:runReport>
  </soap:Body>
</soap:Envelope>`;
}

// Response parser. removeNSPrefix strips the ns2:/env: prefixes so we can
// read reportBytes without caring which prefix the server chose.
const responseParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Same reasoning as report-mapper.js: never let this coerce values to
  // numbers. reportBytes is base64 and must stay an exact string.
  parseTagValue: false,
  trimValues: true,
});

/**
 * Run a BIP report and return its raw XML output as a string.
 *
 * @param {string} reportAbsolutePath - e.g. "/Custom/.../zatca_report.xdo"
 * @param {Object} parameters - report parameters (name -> value)
 * @returns {Promise<string>} the report's XML output
 */
export async function runBipReport(reportAbsolutePath, parameters = {}) {
  if (!reportAbsolutePath) {
    throw new Error('runBipReport: reportAbsolutePath is required (set BIP_REPORT_PATH in .env).');
  }
  if (!oracleConfig.baseUrl) {
    throw new Error('runBipReport: ORACLE_BASE_URL is not set.');
  }

  // The BIP SOAP service lives at the Fusion host root, NOT under the
  // /fscmRestApi/resources/... path used for REST. Strip any REST suffix
  // off ORACLE_BASE_URL so both can share one env var.
  const host = oracleConfig.baseUrl.replace(/\/fscmRestApi.*$/, '').replace(/\/+$/, '');
  const endpoint = `${host}/xmlpserver/services/ExternalReportWSSService`;

  const basicAuth = Buffer.from(`${oracleConfig.username}:${oracleConfig.password}`).toString('base64');
  const envelope = buildRunReportEnvelope(reportAbsolutePath, parameters);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        // SOAP 1.2 uses application/soap+xml. If your instance rejects this,
        // it's expecting SOAP 1.1 instead — switch to 'text/xml' and change
        // the envelope namespace to http://schemas.xmlsoap.org/soap/envelope/
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        SOAPAction: 'runReport',
        Authorization: `Basic ${basicAuth}`,
      },
      body: envelope,
    });
  } catch (err) {
    throw new Error(`Could not reach BI Publisher SOAP endpoint ${endpoint}: ${err.message}`);
  }

  const text = await response.text();

  if (!response.ok) {
    // BIP returns SOAP faults with a 500; the fault string is far more
    // useful than the status code, so surface it.
    const faultMatch = text.match(/<(?:\w+:)?(?:faultstring|Text)[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:faultstring|Text)>/i);
    const detail = faultMatch ? faultMatch[1].trim() : text.slice(0, 800);
    throw new Error(`BI Publisher runReport failed (HTTP ${response.status}): ${detail}`);
  }

  let parsed;
  try {
    parsed = responseParser.parse(text);
  } catch (err) {
    throw new Error(`Could not parse BI Publisher SOAP response: ${err.message}`);
  }

  const reportBytes = parsed?.Envelope?.Body?.runReportResponse?.runReportReturn?.reportBytes;

  if (!reportBytes) {
    throw new Error(
      `BI Publisher response contained no reportBytes. This usually means the report ran but ` +
      `returned no rows, or the report path is wrong. Response head: ${text.slice(0, 500)}`
    );
  }

  const reportXml = Buffer.from(String(reportBytes), 'base64').toString('utf8');

  // A report that runs successfully but matches no rows still returns a
  // valid (empty) document — catch that here rather than letting the parser
  // fail with a confusing "no <G_2> rows" message.
  if (!reportXml.includes('<G_2')) {
    throw new Error(
      `BI Publisher returned a report with no <G_2> rows — the report ran but matched no data ` +
      `for parameters ${JSON.stringify(parameters)}. Check the parameter names/values match the ` +
      `report definition, and that flattenXML is false.`
    );
  }

  return reportXml;
}

/**
 * Fetch the report XML for one invoice by invoice number.
 *
 * TODO: BIP_INVOICE_PARAM_NAME must match your report's actual parameter
 * name exactly (case-sensitive) — check the report's parameter definition in
 * the BIP catalog. It's set via env so you can fix it without a code change.
 */
export async function fetchInvoiceReportXml(invoiceNumber) {
  return runBipReport(bipConfig.reportPath, {
    [bipConfig.invoiceParamName]: invoiceNumber,
  });
}
