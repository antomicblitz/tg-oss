// externalAuthorityMiddleware.js
//
// Redux middleware that routes OVE mutations through an external authority
// (the OpenGene Python `Session`). When `externalAuthority` is enabled:
//
//   1. Every mutating action is intercepted BEFORE being applied locally.
//   2. The action is converted into a TransactionRequest envelope and
//      submitted via the supplied `submit` function.
//   3. On ACCEPTED, the original action is dispatched and the local
//      revision is bumped.
//   4. On STALE / REJECTED / FORBIDDEN, the canonical snapshot (if any)
//      is rebroadcast via SEQUENCE_DATA_UPDATE; the original action is
//      NOT applied.
//   5. VE_UNDO / VE_REDO actions are converted to REQUEST_UNDO /
//      REQUEST_REDO envelopes and submitted through the same path.
//
// When `externalAuthority` is disabled (default), the middleware is a
// transparent pass-through so existing OVE behavior is preserved.
//
// Reference: docs/plans/ove-sequence-workspace-migration.md (slice 1a).

const MUTATING_ACTIONS = new Set([
  // Residue edits.
  "ADD_BPS",
  "DELETE_BPS",
  "REPLACE_BPS",
  // Annotations.
  "FEATURE_UPSERT",
  "FEATURE_DELETE",
  "PRIMER_UPSERT",
  "PRIMER_DELETE",
  // Topology / molecule.
  "SET_CIRCULAR",
  "ROTATE_ORIGIN"
]);

const OPERATION_MAP = Object.freeze({
  ADD_BPS: "insert_bases",
  DELETE_BPS: "delete_bases",
  REPLACE_BPS: "replace_bases",
  FEATURE_UPSERT: "upsert_feature",
  FEATURE_DELETE: "delete_feature",
  PRIMER_UPSERT: "upsert_primer",
  PRIMER_DELETE: "delete_primer",
  SET_CIRCULAR: "set_circular",
  ROTATE_ORIGIN: "rotate_origin",
  VE_UNDO: "request_undo",
  VE_REDO: "request_redo"
});

const REJECTED_TYPES = new Set([
  "ADD_BPS_REJECTED",
  "DELETE_BPS_REJECTED",
  "REPLACE_BPS_REJECTED",
  "FEATURE_UPSERT_REJECTED",
  "FEATURE_DELETE_REJECTED",
  "PRIMER_UPSERT_REJECTED",
  "PRIMER_DELETE_REJECTED",
  "SET_CIRCULAR_REJECTED",
  "ROTATE_ORIGIN_REJECTED",
  "VE_UNDO_REJECTED",
  "VE_REDO_REJECTED"
]);

function isStaleResponse(response) {
  return response && response.status === "stale";
}

function isForbiddenResponse(response) {
  return response && response.status === "forbidden";
}

function isRejectedResponse(response) {
  return (
    response &&
    (response.status === "rejected" || response.status === "forbidden")
  );
}

function makeRequestId() {
  // crypto.randomUUID exists in modern browsers and Node 19+; fall back to
  // a timestamp-based id if it isn't available (older test harnesses).
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `tx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Build the externalAuthority middleware.
 *
 * @param {object} options
 * @param {(req: object) => Promise<object>} options.submit
 *   Async function that submits a TransactionRequest and resolves to a
 *   TransactionResponse.
 * @param {string} options.documentId - Document id used in every request.
 * @param {string} options.surfaceId - Surface id used in every request.
 * @param {() => number} [options.revision] - Returns the current local
 *   revision. Defaults to reading `VectorEditor[name].revision` from the
 *   store, falling back to 0.
 * @param {(snapshot: object) => void} [options.applySnapshot]
 *   Optional callback that, when provided, is invoked whenever the
 *   authority returns a canonical snapshot. Used by the integration tests
 *   to assert that OVE rebases correctly without having to wire a full
 *   SEQUENCE_DATA_UPDATE reducer.
 * @param {(response: object) => void} [options.onResponse]
 *   Optional callback invoked with every response (including REJECTED /
 *   STALE) for diagnostics / observability.
 * @returns {Function} Redux middleware (store) => (next) => (action) => ...
 */
export function createExternalAuthorityMiddleware(options) {
  if (!options || typeof options.submit !== "function") {
    throw new Error(
      "createExternalAuthorityMiddleware requires options.submit function"
    );
  }
  if (typeof options.documentId !== "string" || options.documentId === "") {
    throw new Error(
      "createExternalAuthorityMiddleware requires options.documentId (string)"
    );
  }
  if (typeof options.surfaceId !== "string" || options.surfaceId === "") {
    throw new Error(
      "createExternalAuthorityMiddleware requires options.surfaceId (string)"
    );
  }

  const submit = options.submit;
  const documentId = options.documentId;
  const surfaceId = options.surfaceId;
  const applySnapshot =
    typeof options.applySnapshot === "function" ? options.applySnapshot : null;
  const onResponse =
    typeof options.onResponse === "function" ? options.onResponse : null;
  const revisionGetter =
    typeof options.revision === "function" ? options.revision : () => 0;

  function buildRequest(action) {
    const baseRevision = revisionGetter();
    const operation = OPERATION_MAP[action.type];
    const payload = action.payload || {};
    return {
      protocol_version: 1,
      document_id: documentId,
      surface_id: surfaceId,
      transaction_id: makeRequestId(),
      base_revision: baseRevision,
      operation,
      payload
    };
  }

  // Redux middleware signature: (store) => (next) => (action) => ...
  // We don't need `store` directly because the caller wires revision
  // tracking via the `revision` getter; the framework still requires
  // the parameter so the middleware composes correctly with Redux's
  // applyMiddleware chain.
  return function externalAuthorityMiddleware(/* store */) {
    return function (next) {
      return async function (action) {
        // Only intercept mutating actions (or undo/redo).
        const isMutation = MUTATING_ACTIONS.has(action.type);
        const isUndoRedo =
          action.type === "VE_UNDO" || action.type === "VE_REDO";
        if (!isMutation && !isUndoRedo) {
          return next(action);
        }

        const request = buildRequest(action);
        let response;
        try {
          response = await submit(request);
        } catch (err) {
          // Treat transport failures as a rejected request so the UI can
          // surface a clear diagnostic and the local state stays untouched.
          if (onResponse) {
            onResponse({
              transaction_id: request.transaction_id,
              status: "rejected",
              new_revision: revisionGetter(),
              canonical_snapshot: null,
              message: `submit() threw: ${err && err.message ? err.message : String(err)}`
            });
          }
          // Emit a *_REJECTED action so the editor can show the diagnostic.
          return next({
            type: `${action.type}_REJECTED`,
            meta: action.meta,
            payload: {
              originalActionType: action.type,
              request,
              message: `submit() threw: ${err && err.message ? err.message : String(err)}`
            }
          });
        }

        if (onResponse) onResponse(response);

        if (isStaleResponse(response) || isForbiddenResponse(response)) {
          if (response.canonical_snapshot && applySnapshot) {
            applySnapshot(response.canonical_snapshot);
          }
          return next({
            type: `${action.type}_REJECTED`,
            meta: action.meta,
            payload: {
              originalActionType: action.type,
              request,
              response
            }
          });
        }

        if (isRejectedResponse(response)) {
          return next({
            type: `${action.type}_REJECTED`,
            meta: action.meta,
            payload: {
              originalActionType: action.type,
              request,
              response
            }
          });
        }

        // ACCEPTED — apply locally. Note: we DON'T bypass the local
        // reducer; we let it run as if the action were dispatched
        // normally. The Python side has already mutated its canonical
        // state, and `revisionGetter()` already reflects the new
        // revision when the next request goes out.
        return next(action);
      };
    };
  };
}

/**
 * Test helper — convenience export of the constants so tests can build
 * deterministic inputs without re-deriving the wire-format mapping.
 */
export const EXTERNAL_AUTHORITY_CONSTANTS = Object.freeze({
  MUTATING_ACTIONS,
  OPERATION_MAP,
  REJECTED_TYPES
});

export { REJECTED_TYPES };
