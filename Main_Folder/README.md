# ZATCA + Oracle Fusion Integration

Two pieces, run as separate processes:

```
zatca-integration/        Node.js — fetches invoices from Oracle Fusion,
                           maps them to ZATCA's invoice shape, generates UBL
                           XML, calls the signing service below, then submits
                           to ZATCA and tracks invoice chaining state.

zatca-signing-service/    Java — wraps the real ZATCA SDK jar. Handles
                           canonicalization, hashing, ECDSA signing, and QR
                           code generation by shelling out to ZATCA's own
                           SDK rather than reimplementing that cryptography
                           in JS.
```

## Why two services

The cryptographic/XML-canonicalization core (hash → sign → QR → embed) is
the part most likely to silently produce an invoice that looks fine locally
but fails ZATCA's real validator over some encoding edge case. Since ZATCA
publishes their own Java SDK as the reference implementation, that part now
runs through the actual SDK jar instead of a hand-written JS equivalent.
Everything else (Oracle Fusion integration, mapping, chaining, submission)
stays in Node since there's no compliance benefit to doing that in Java.

## Running both together

1. Start the signing service first (see `zatca-signing-service/README.md`):
   ```bash
   cd zatca-signing-service
   javac -d out $(find src -name "*.java")
   ZATCA_SDK_JAR_PATH=... ZATCA_CERT_PATH=... ZATCA_PRIVATE_KEY_PATH=... \
     java -cp out com.zatca.signing.ZatcaSigningService
   ```
2. Point the Node side at it and run:
   ```bash
   cd zatca-integration
   cp .env.example .env   # fill in the values
   npm install
   node index.js <customerTransactionId>
   ```

## Status / what's been verified vs. what's still open

**Verified by actually running code, not just written:**
- The Node bundle's syntax and internal wiring (`node --check` on every file).
- The Java service compiles and runs.
- A live HTTP call to the Java service, which shelled out to your actual
  ZATCA SDK jar and returned a correctly signed invoice with an embedded
  QR code and XAdES signature.
- The Node `signInvoiceViaJavaService` client calling that live service
  successfully end to end.

**Still open — see the TODOs in `config.js` and `invoice-mapper.js`:**
- Real seller VAT number, name, and structured address data.
- Real supplier/customer address lookups (currently placeholders).
- `@talha7k/zatca`'s existence/API is still unverified — confirm
  `npm view @talha7k/zatca` resolves before relying on it for UBL generation.
- `submitToZatca` has not been tested against a real ZATCA sandbox/simulation
  endpoint — only local signing has been verified.
- Only `-sign` was wired up in the Java service; `-validate` and `-csr` are
  documented as extension points in that service's README but not built.
