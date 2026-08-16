# ZATCA Integration — Sumou Real Estate Company

## Structure

```
Main_Folder/              Node service (orchestration)
  index.js                Pipeline: report -> map -> UBL -> sign -> submit
  bip-soap-client.js      BI Publisher SOAP (ExternalReportWSSService/runReport)
  report-mapper.js        Report XML -> ZATCA shape; handles all 6 doc types
  chain-store.js          Invoice hash chain + per-invoice UUID lookup
  signing-client.js       HTTP client -> Java signing service
  zatca-pipeline.js       ZATCA clearance/reporting submission
  config.js               Seller identity, addresses, endpoints
  .env.example

java-signing-service/     Java service (wraps ZATCA's SDK jar)
  ZatcaSigningService.java   HTTP server (/sign, /health)
  ZatcaSdkSigner.java        SDK jar subprocess invocation
  SdkConfigFactory.java, PemUtil.java, JsonUtil.java
  .env.example
```

Both run as separate processes. Start the Java service first.

## Running

```bash
# Terminal 1 — Java signing service
cd java-signing-service
# configure .env (SDK jar path, cert, key), then compile and run

# Terminal 2 — Node
cd Main_Folder
npm install
cp .env.example .env      # fill in
node index.js 1000        # dry run (submit=false)
```

## The 6 ZATCA document types

| TYPE_CODE | SUBTYPE  | Document               | Endpoint  |
|-----------|----------|------------------------|-----------|
| 388       | 0100000  | Standard invoice       | clearance |
| 381       | 0100000  | Standard credit note   | clearance |
| 383       | 0100000  | Standard debit note    | clearance |
| 388       | 0200000  | Simplified invoice     | reporting |
| 381       | 0200000  | Simplified credit note | reporting |
| 383       | 0200000  | Simplified debit note  | reporting |

All 6 are handled and were verified to generate valid UBL. Standard (01) = B2B,
Simplified (02) = B2C. Credit/debit notes additionally carry
`cac:BillingReference` + `cbc:InstructionNote`.

## BEFORE GOING LIVE

1. **`FIRST_INVOICE_PLACEHOLDER_HASH`** in `chain-store.js` is still a literal
   `TODO_...` string. The very first invoice in the chain needs ZATCA's
   specified placeholder hash. This WILL be rejected as-is.
2. **Report columns missing** for credit/debit notes:
   `ORIGINAL_INVOICE_NUMBER`, `ADJUSTMENT_REASON`. Without them only the 2
   plain-invoice types can be issued (the other 4 throw a clear error).
3. **`SELLER_ADDITIONAL_NUMBER` / `BUYER_ADDITIONAL_NUMBER`** columns don't
   exist in the report; ZATCA requires a 4-digit additional number on B2B
   addresses. Seller falls back to config; buyer has no fallback.
4. **`BUYER_STREET` / `BUYER_DISTRICT` look transposed** in the sample report
   data — verify the report's SQL.
5. **`supplierAddressDefault.street` is null** in `config.js` — the address you
   provided had no street name. `assertRequiredConfig()` will refuse to run
   until it's set.
6. **Chain store is a JSON file** — no locking, will race under concurrency.
   Move to a database before production. Back it up: losing it makes credit
   notes against older invoices impossible to issue.
7. **ZATCA auth** — `ZATCA_USERNAME`/`PASSWORD` must be the CSID
   binarySecurityToken + secret from onboarding, not portal credentials.

## Complete file manifest

### In version control (17 files)

**Main_Folder/** — Node service
| File | Purpose |
|---|---|
| `index.js` | Entry point; orchestrates the pipeline |
| `bip-soap-client.js` | BI Publisher SOAP (`ExternalReportWSSService/runReport`) |
| `report-mapper.js` | Report XML -> ZATCA shape; all 6 document types |
| `chain-store.js` | Invoice hash chain + per-invoice UUID lookup |
| `signing-client.js` | HTTP client -> Java signing service |
| `zatca-pipeline.js` | ZATCA clearance/reporting submission |
| `config.js` | Seller identity, addresses, endpoints |
| `package.json` | Dependencies |
| `.env.example` | Template for `.env` |

**java-signing-service/** — Java service (all 5 classes are in package
`com.zatca.signing` and reference each other; none is optional)
| File | Purpose |
|---|---|
| `ZatcaSigningService.java` | HTTP server, entry point (`/sign`, `/health`) |
| `ZatcaSdkSigner.java` | Invokes the ZATCA SDK jar as a subprocess |
| `SdkConfigFactory.java` | Writes the SDK's config files |
| `PemUtil.java` | PEM cert/key handling |
| `JsonUtil.java` | Minimal JSON encoding (no external deps) |
| `run.sh` / `run.ps1` | Load `.env`, compile, run |
| `.env.example` | Template for `.env` |
| `README.md` | Service notes |

**Root:** `README.md`, `.gitignore`

### NOT in the repo — you must supply these

| What | Where from |
|---|---|
| ZATCA SDK jar | Fatoora portal download. Path goes in `ZATCA_SDK_JAR_PATH`. |
| `cert.pem` / `private-key.pem` | Your CSID from onboarding. For structural testing only, the SDK jar bundles a sample pair (`cert/certificate.cer`, `PrivateKey.pem` at the jar root) — **not valid for real submission**. |
| `Main_Folder/.env` | Copy from `.env.example` |
| `java-signing-service/.env` | Copy from `.env.example` |

### Generated at runtime — do not commit

`node_modules/`, `package-lock.json`, `chain-store.json`, `out/`, `*.class`,
`invoice_*_final.xml`

**`chain-store.json` is special**: it holds your invoice chain (last hash, ICV
counter, per-invoice UUIDs). It's gitignored because merging chain state
across machines corrupts the chain — but you must **back it up separately**.
Losing it makes credit/debit notes against earlier invoices impossible to
issue, because the original invoice's UUID exists nowhere else.

## Requirements

- **Node 18+** (uses built-in `fetch`)
- **A JDK, not just a JRE** — you need `javac` to compile the signing service.
  ZATCA documents JDK 11-14 as supported for their SDK.
