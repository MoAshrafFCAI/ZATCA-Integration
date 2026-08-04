// chain-store.js
// -----------------------------------------------------------------------------
// ZATCA Phase 2 requires every invoice to reference the hash of the invoice
// issued immediately before it (the "Previous Invoice Hash" / PIH), forming a
// cryptographic chain. The original code hardcoded this to `null`, which will
// fail validation for anything after the very first invoice.
//
// This is a minimal file-based store to make that concrete and testable.
// For production, replace this with a real database row (e.g. a single-row
// "invoice_sequence" table) written inside the same transaction as the AR
// invoice, with row-level locking — a flat file will race under concurrent
// invoice runs.
// -----------------------------------------------------------------------------

import fs from 'fs';

const STORE_PATH = process.env.ZATCA_CHAIN_STORE_PATH || './chain-store.json';

// TODO: confirm this against ZATCA's implementation guidelines before go-live.
// ZATCA specifies a fixed placeholder value to use as the "previous invoice
// hash" for the very first invoice in a chain (since there is no real
// predecessor). Do not leave this as `null` — invoice #1 needs this exact
// value or it will be rejected. Look this up in the current Fatoora technical
// spec rather than trusting a hardcoded guess here.
export const FIRST_INVOICE_PLACEHOLDER_HASH = 'TODO_SET_ZATCA_SPECIFIED_FIRST_HASH';

function readStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return { lastInvoiceHash: null, lastInvoiceCounter: 0 };
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function writeStore(state) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

export function getPreviousInvoiceHash() {
  const state = readStore();
  return state.lastInvoiceHash || FIRST_INVOICE_PLACEHOLDER_HASH;
}

export function getNextInvoiceCounter() {
  return readStore().lastInvoiceCounter + 1;
}

// Call this ONLY after a successful ZATCA submission — recording a hash for
// an invoice that never actually cleared/reported will corrupt the chain for
// every invoice after it.
export function recordInvoice(hashBase64, counter) {
  writeStore({ lastInvoiceHash: hashBase64, lastInvoiceCounter: counter });
}
