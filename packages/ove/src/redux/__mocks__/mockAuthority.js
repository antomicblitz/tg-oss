// mockAuthority.js
//
// A Node-side stand-in for the OpenGene Python `Session` during OVE fork
// tests. Mirrors the protocol envelope defined by Python's
// `opengene.views.ove.messages` (TransactionRequest / TransactionResponse
// / AckStatus / OperationKind) so the middleware can be exercised without
// the WebEngine + QWebChannel infrastructure.
//
// The mock keeps a simple per-document sequence with optional features
// and primers. It validates each transaction against the current revision,
// emits ACCEPTED / STALE / REJECTED / FORBIDDEN outcomes, and stores every
// accepted transaction in a history log for the tests to assert against.
//
// Reference: docs/plans/ove-sequence-workspace-migration.md (slice 1a).

import assert from "assert";

// Match Python's `OperationKind` enum values.
export const OperationKind = Object.freeze({
  REPLACE_BASES: "replace_bases",
  INSERT_BASES: "insert_bases",
  DELETE_BASES: "delete_bases",
  REVERSE_COMPLEMENT: "reverse_complement",
  SELECTION_UPDATE: "selection_update",
  CARET_UPDATE: "caret_update",
  UPSERT_FEATURE: "upsert_feature",
  DELETE_FEATURE: "delete_feature",
  UPSERT_PRIMER: "upsert_primer",
  DELETE_PRIMER: "delete_primer",
  SET_CIRCULAR: "set_circular",
  ROTATE_ORIGIN: "rotate_origin",
  REQUEST_UNDO: "request_undo",
  REQUEST_REDO: "request_redo",
  ALIGN: "align"
});

export const AckStatus = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  STALE: "stale",
  FORBIDDEN: "forbidden"
});

const PROTOCOL_VERSION = 1;
const VALID_RESIDUES = new Set([
  "A",
  "C",
  "G",
  "T",
  "U",
  "N",
  "R",
  "Y",
  "S",
  "W",
  "K",
  "M",
  "B",
  "D",
  "H",
  "V"
]);
const MUTATING_OPS = new Set([
  OperationKind.REPLACE_BASES,
  OperationKind.INSERT_BASES,
  OperationKind.DELETE_BASES,
  OperationKind.REVERSE_COMPLEMENT,
  OperationKind.UPSERT_FEATURE,
  OperationKind.DELETE_FEATURE,
  OperationKind.UPSERT_PRIMER,
  OperationKind.DELETE_PRIMER,
  OperationKind.SET_CIRCULAR,
  OperationKind.ROTATE_ORIGIN
]);

const IUPAC_COMPLEMENT = Object.freeze({
  A: "T",
  T: "A",
  C: "G",
  G: "C",
  U: "A",
  N: "N",
  R: "Y",
  Y: "R",
  S: "S",
  W: "W",
  K: "M",
  M: "K",
  B: "V",
  V: "B",
  D: "H",
  H: "D"
});

let _txnCounter = 0;
function nextTransactionId() {
  _txnCounter += 1;
  return `mock-tx-${_txnCounter}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isValidResidues(text) {
  for (const ch of String(text).toUpperCase()) {
    if (!VALID_RESIDUES.has(ch)) return false;
  }
  return true;
}

/**
 * Create a mock authority backend.
 *
 * @param {object} options
 * @param {object} options.initial - Initial document snapshot
 *   ({ sequence, circular, features, primers }).
 * @param {string} options.documentId - Identifier the mock answers for.
 * @param {number} [options.startingRevision=0] - Initial revision number.
 * @returns {{
 *   submit: (req: object) => Promise<object>,
 *   snapshot: () => object,
 *   revision: () => number,
 *   history: () => object[],
 *   reset: () => void
 * }}
 */
export function createMockAuthority(options) {
  const documentId = options.documentId;
  const initial = clone(options.initial);

  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new Error("createMockAuthority requires documentId");
  }
  if (!initial || typeof initial.sequence !== "string") {
    throw new Error(
      "createMockAuthority requires initial.sequence (string of residues)"
    );
  }

  let state = {
    sequence: String(initial.sequence).toUpperCase(),
    circular: Boolean(initial.circular),
    features: Array.isArray(initial.features) ? clone(initial.features) : [],
    primers: Array.isArray(initial.primers) ? clone(initial.primers) : []
  };
  let revision =
    typeof options.startingRevision === "number" ? options.startingRevision : 0;
  const history = [];
  let forbidden = false;

  function snapshot() {
    return clone({
      document_id: documentId,
      revision,
      sequence: state.sequence,
      circular: state.circular,
      features: state.features,
      primers: state.primers
    });
  }

  function buildResponse(req, status, extras = {}) {
    return {
      transaction_id: req.transaction_id,
      status,
      new_revision: revision,
      canonical_snapshot: status === AckStatus.STALE ? snapshot() : null,
      message: extras.message || "",
      latency_ms: extras.latency_ms ?? null
    };
  }

  async function submit(req) {
    assert.ok(req, "submit() requires a request envelope");
    assert.strictEqual(
      req.protocol_version,
      PROTOCOL_VERSION,
      `protocol_version mismatch: expected ${PROTOCOL_VERSION}, got ${req.protocol_version}`
    );
    assert.strictEqual(
      req.document_id,
      documentId,
      `document_id mismatch: expected ${documentId}, got ${req.document_id}`
    );

    if (forbidden) {
      return buildResponse(req, AckStatus.FORBIDDEN, {
        message: "authority is in read-only mode"
      });
    }

    const op = req.operation;
    const payload = req.payload || {};

    // Stale base_revision always short-circuits to STALE.
    if (MUTATING_OPS.has(op) && req.base_revision !== revision) {
      return buildResponse(req, AckStatus.STALE, {
        message: `base_revision ${req.base_revision} != current ${revision}`
      });
    }

    switch (op) {
      case OperationKind.REPLACE_BASES: {
        const { start, end, replacement } = payload;
        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          end < start ||
          start < 0 ||
          end > state.sequence.length
        ) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `replace_bases out of bounds: [${start}, ${end}) len=${state.sequence.length}`
          });
        }
        if (!isValidResidues(replacement || "")) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `replace_bases invalid residue in ${JSON.stringify(
              replacement
            )}`
          });
        }
        const before = state.sequence;
        state.sequence =
          before.slice(0, start) +
          String(replacement).toUpperCase() +
          before.slice(end);
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED, {
          message: `replaced ${end - start} bp`
        });
      }
      case OperationKind.INSERT_BASES: {
        const { position } = payload;
        // Python's wire schema uses `residues`. Keep accepting the older
        // `sequence` field so historical mock fixtures still round-trip.
        const residues =
          payload.residues !== undefined ? payload.residues : payload.sequence;
        if (
          typeof position !== "number" ||
          position < 0 ||
          position > state.sequence.length
        ) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `insert_bases position out of bounds: ${position}`
          });
        }
        if (!isValidResidues(residues || "")) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `insert_bases invalid residue in ${JSON.stringify(residues)}`
          });
        }
        const insert = String(residues || "").toUpperCase();
        state.sequence =
          state.sequence.slice(0, position) +
          insert +
          state.sequence.slice(position);
        // Insertions rebase downstream feature/primer endpoints >= position.
        for (const f of state.features) {
          if (f.end >= position) f.end += insert.length;
          else if (f.start >= position) f.start += insert.length;
        }
        for (const p of state.primers) {
          if (p.end >= position) p.end += insert.length;
          else if (p.start >= position) p.start += insert.length;
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED, {
          message: `inserted ${insert.length} bp at ${position}`
        });
      }
      case OperationKind.DELETE_BASES: {
        const { start, end } = payload;
        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          end < start ||
          start < 0 ||
          end > state.sequence.length
        ) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `delete_bases out of bounds: [${start}, ${end})`
          });
        }
        const length = end - start;
        state.sequence =
          state.sequence.slice(0, start) + state.sequence.slice(end);
        // Truncate / drop features that overlap the deleted range.
        state.features = state.features
          .map(f => ({ ...f }))
          .filter(f => !(f.start >= end || f.end <= start));
        for (const f of state.features) {
          if (f.end > start) f.end = Math.max(start, f.end - length);
          if (f.start > start) f.start = Math.max(start, f.start - length);
        }
        state.primers = state.primers
          .map(p => ({ ...p }))
          .filter(p => !(p.start >= end || p.end <= start));
        for (const p of state.primers) {
          if (p.end > start) p.end = Math.max(start, p.end - length);
          if (p.start > start) p.start = Math.max(start, p.start - length);
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED, {
          message: `deleted ${length} bp at [${start}, ${end})`
        });
      }
      case OperationKind.REVERSE_COMPLEMENT: {
        const length = state.sequence.length;
        state.sequence = state.sequence
          .split("")
          .reverse()
          .map(ch => IUPAC_COMPLEMENT[ch] || ch)
          .join("");
        for (const f of state.features) {
          const start = length - f.end;
          const end = length - f.start;
          f.start = start;
          f.end = end;
          f.strand = f.strand === -1 ? 1 : -1;
        }
        for (const p of state.primers) {
          const start = length - p.end;
          const end = length - p.start;
          p.start = start;
          p.end = end;
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.SET_CIRCULAR: {
        if (typeof payload.circular !== "boolean") {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `set_circular requires payload.circular (boolean)`
          });
        }
        state.circular = payload.circular;
        // Optional atomic annotation replacement (confirmed linearize
        // truncation).
        if (Array.isArray(payload.features)) {
          state.features = clone(payload.features);
        }
        if (Array.isArray(payload.primers)) {
          state.primers = clone(payload.primers);
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.ROTATE_ORIGIN: {
        // Accept both the synthetic `origin` and the explicit `new_origin`
        // (0-based) wire shapes.
        const origin =
          typeof payload.new_origin === "number"
            ? payload.new_origin
            : payload.origin;
        if (typeof origin !== "number" || origin < 0) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `rotate_origin requires non-negative origin`
          });
        }
        const len = state.sequence.length;
        if (origin >= len) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `rotate_origin origin ${origin} >= length ${len}`
          });
        }
        if (origin > 0) {
          state.sequence =
            state.sequence.slice(origin) + state.sequence.slice(0, origin);
          for (const f of state.features) {
            f.start = (f.start - origin + len) % len;
            f.end = (f.end - origin + len) % len;
          }
          for (const p of state.primers) {
            p.start = (p.start - origin + len) % len;
            p.end = (p.end - origin + len) % len;
          }
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.UPSERT_FEATURE: {
        const feature = payload.feature;
        if (!feature || typeof feature.start !== "number") {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `upsert_feature requires payload.feature.start`
          });
        }
        const idx = state.features.findIndex(
          f => f.id != null && f.id === feature.id
        );
        if (idx >= 0) state.features[idx] = clone(feature);
        else state.features.push(clone(feature));
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.DELETE_FEATURE: {
        const ids = Array.isArray(payload.ids) ? payload.ids : [payload.id];
        const before = state.features.length;
        state.features = state.features.filter(f => !ids.includes(f.id));
        if (state.features.length === before) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `delete_feature: ids ${JSON.stringify(ids)} not found`
          });
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.UPSERT_PRIMER: {
        const primer = payload.primer;
        if (!primer || typeof primer.start !== "number") {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `upsert_primer requires payload.primer.start`
          });
        }
        const idx = state.primers.findIndex(
          p => p.id != null && p.id === primer.id
        );
        if (idx >= 0) state.primers[idx] = clone(primer);
        else state.primers.push(clone(primer));
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.DELETE_PRIMER: {
        const ids = Array.isArray(payload.ids) ? payload.ids : [payload.id];
        const before = state.primers.length;
        state.primers = state.primers.filter(p => !ids.includes(p.id));
        if (state.primers.length === before) {
          return buildResponse(req, AckStatus.REJECTED, {
            message: `delete_primer: ids ${JSON.stringify(ids)} not found`
          });
        }
        revision += 1;
        history.push({ op, payload: clone(payload), revision });
        return buildResponse(req, AckStatus.ACCEPTED);
      }
      case OperationKind.REQUEST_UNDO:
      case OperationKind.REQUEST_REDO: {
        // Mock has no real undo history. Accept the request without
        // mutating state so the bridge contract round-trips.
        return buildResponse(req, AckStatus.ACCEPTED, {
          message: `${op} acknowledged`
        });
      }
      case OperationKind.SELECTION_UPDATE:
      case OperationKind.CARET_UPDATE:
        // Read-only; never bumps revision.
        return buildResponse(req, AckStatus.ACCEPTED, { message: "ok" });
      case OperationKind.ALIGN:
        return buildResponse(req, AckStatus.ACCEPTED, {
          message: "alignment stubbed"
        });
      default:
        return buildResponse(req, AckStatus.REJECTED, {
          message: `unknown operation: ${op}`
        });
    }
  }

  return {
    submit,
    snapshot,
    revision: () => revision,
    history: () => clone(history),
    setForbidden: v => {
      forbidden = Boolean(v);
    },
    reset: (newInitial, newRevision) => {
      state = clone(newInitial);
      revision = typeof newRevision === "number" ? newRevision : revision + 1;
      history.length = 0;
    }
  };
}

/**
 * Build a TransactionRequest envelope mirroring Python's `TransactionRequest.make`.
 *
 * @param {object} args
 * @param {string} args.documentId
 * @param {string} args.surfaceId
 * @param {number} args.baseRevision
 * @param {string} args.operation - One of OperationKind values
 * @param {object} [args.payload]
 * @param {string} [args.transactionId] - Override for deterministic test ids.
 * @returns {object} TransactionRequest-shaped envelope.
 */
export function makeRequest(args) {
  return {
    protocol_version: PROTOCOL_VERSION,
    document_id: args.documentId,
    surface_id: args.surfaceId,
    transaction_id: args.transactionId || nextTransactionId(),
    base_revision: args.baseRevision,
    operation: args.operation,
    payload: args.payload || {}
  };
}
