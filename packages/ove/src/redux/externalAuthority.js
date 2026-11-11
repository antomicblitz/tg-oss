// externalAuthorityMiddleware.js
//
// Redux middleware that routes OVE mutations through an external authority
// (the OpenGene Python `Session`). When `externalAuthority` is enabled:
//
//   1. Every mutating action is intercepted BEFORE being applied locally.
//   2. The action is converted into a TransactionRequest envelope and
//      submitted via the supplied `submit` function.
//   3. On ACCEPTED, the canonical state is applied back to OVE. Synthetic
//      actions (the OpenGene-specific `REPLACE_BPS` family) keep their
//      historical behaviour and are forwarded to the reducer; the real OVE
//      actions (`SEQUENCE_DATA_UPDATE`, `UPSERT_FEATURE`, ...) apply the
//      canonical snapshot instead, because their local payload carries a
//      full sequenceData whose annotation remap may diverge from Python's
//      editing seam.
//   4. On STALE / REJECTED / FORBIDDEN, the canonical snapshot (if any)
//      is rebroadcast via the supplied `applySnapshot`; the original action
//      is NOT applied.
//   5. VE_UNDO / VE_REDO actions are converted to REQUEST_UNDO /
//      REQUEST_REDO envelopes and submitted through the same path. Python
//      owns the only undo stack, so the local OVE undo middleware must not
//      run first; the store wires this middleware ahead of
//      `vectorEditorMiddleware` (see `makeStore.js`).
//
// When `externalAuthority` is disabled (default), the middleware is a
// transparent pass-through so existing OVE behavior is preserved.
//
// Reference: docs/plans/ove-sequence-workspace-migration.md (slice 1a).

// Synthetic actions: OpenGene-specific Redux actions that carry a precise
// mutation payload. They are not dispatched by stock OVE, but the host page
// and the fork tests use them to drive the protocol directly.
const SYNTHETIC_MUTATING_ACTIONS = new Set([
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

// Real OVE actions: the actions the stock editor dispatches for user edits.
// `SEQUENCE_DATA_UPDATE` carries a full sequenceData snapshot; the middleware
// derives a half-open residue mutation from it. The annotation actions carry
// the annotation object; `UPDATE_CIRCULAR` carries the boolean topology.
const REAL_MUTATING_ACTIONS = new Set([
  "SEQUENCE_DATA_UPDATE",
  "UPSERT_FEATURE",
  "DELETE_FEATURE",
  "UPSERT_PRIMER",
  "DELETE_PRIMER",
  "UPDATE_CIRCULAR"
]);

const MUTATING_ACTIONS = new Set([
  ...SYNTHETIC_MUTATING_ACTIONS,
  ...REAL_MUTATING_ACTIONS
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
  "SEQUENCE_DATA_UPDATE_REJECTED",
  "UPSERT_FEATURE_REJECTED",
  "DELETE_FEATURE_REJECTED",
  "UPSERT_PRIMER_REJECTED",
  "DELETE_PRIMER_REJECTED",
  "UPDATE_CIRCULAR_REJECTED",
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
 * Derive a half-open residue mutation from two full sequences.
 *
 * The common prefix and suffix are stripped; the remaining middle span is the
 * replacement. This is the canonical way to turn OVE's full-snapshot
 * `SEQUENCE_DATA_UPDATE` into the `replace_bases` wire operation without
 * guessing which gesture produced it.
 *
 * @param {string} oldSequence - The authority's current residues.
 * @param {string} newSequence - The residues OVE wants to apply.
 * @returns {{start: number, end: number, replacement: string}}
 */
export function diffResidues(oldSequence, newSequence) {
  const oldLength = oldSequence.length;
  const newLength = newSequence.length;
  const maxPrefix = Math.min(oldLength, newLength);
  let prefix = 0;
  while (prefix < maxPrefix && oldSequence[prefix] === newSequence[prefix]) {
    prefix += 1;
  }
  const maxSuffix = Math.min(oldLength, newLength) - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldSequence[oldLength - 1 - suffix] === newSequence[newLength - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    end: oldLength - suffix,
    replacement: newSequence.slice(prefix, newLength - suffix)
  };
}

const COMPLEMENT = Object.freeze({
  A: "T",
  T: "A",
  C: "G",
  G: "C",
  U: "A",
  N: "N"
});

function reverseComplement(sequence) {
  let out = "";
  for (let i = sequence.length - 1; i >= 0; i -= 1) {
    const base = sequence[i].toUpperCase();
    out += COMPLEMENT[base] || base;
  }
  return out;
}

function isRotation(oldSequence, newSequence) {
  if (oldSequence.length !== newSequence.length) return false;
  if (oldSequence.length === 0) return false;
  return (newSequence + newSequence).includes(oldSequence);
}

function normalizeId(payload) {
  if (typeof payload === "string") return payload;
  if (
    payload &&
    typeof payload === "object" &&
    typeof payload.id === "string"
  ) {
    return payload.id;
  }
  return null;
}

/**
 * Translate a real OVE action into a wire operation + payload.
 *
 * Returns `{error}` when the action cannot be routed safely. The caller then
 * rebroadcasts the canonical snapshot instead of applying a divergent local
 * change. The one unsupported case is a `SEQUENCE_DATA_UPDATE` that changes
 * annotations without changing residues: stock OVE dispatches annotation
 * edits through `UPSERT_FEATURE` / `DELETE_FEATURE` / `UPSERT_PRIMER` /
 * `DELETE_PRIMER`, so a residue-free full-snapshot update is not a supported
 * mutation and must not silently overwrite Python's annotations.
 */
function buildRealRequest(action, canonicalSequence) {
  const payload = action.payload;
  switch (action.type) {
    case "SEQUENCE_DATA_UPDATE": {
      const newSequence =
        payload && typeof payload.sequence === "string"
          ? payload.sequence
          : null;
      if (newSequence === null) {
        return { error: "SEQUENCE_DATA_UPDATE without a sequence string" };
      }
      if (typeof canonicalSequence !== "string") {
        return { error: "no canonical sequence available to diff" };
      }
      if (newSequence === canonicalSequence) {
        return {
          error:
            "SEQUENCE_DATA_UPDATE changed annotations only; route annotation " +
            "edits through UPSERT_FEATURE / DELETE_FEATURE / UPSERT_PRIMER / " +
            "DELETE_PRIMER"
        };
      }
      // Reason: a reverse complement or an origin rotation changes residues
      // *and* annotation coordinates/strands at once. The wire protocol has no
      // operation that carries both, and a plain `replace_bases` would leave
      // feature strands and coordinates wrong. Reject explicitly and
      // rebroadcast the canonical state instead of silently corrupting the
      // annotations; the Qt Edit ▸ Reverse Complement / Set Origin commands
      // remain the canonical path for those transforms.
      if (reverseComplement(canonicalSequence) === newSequence) {
        return {
          error:
            "SEQUENCE_DATA_UPDATE is a reverse complement; use the canonical " +
            "Edit ▸ Reverse Complement command so feature strands and " +
            "coordinates are remapped by the editing seam"
        };
      }
      if (isRotation(canonicalSequence, newSequence)) {
        return {
          error:
            "SEQUENCE_DATA_UPDATE is an origin rotation; use the canonical " +
            "Set Origin command so feature coordinates are remapped"
        };
      }
      return {
        operation: "replace_bases",
        payload: diffResidues(canonicalSequence, newSequence)
      };
    }
    case "UPSERT_FEATURE":
      return { operation: "upsert_feature", payload: { feature: payload } };
    case "DELETE_FEATURE": {
      const id = normalizeId(payload);
      if (id === null) return { error: "DELETE_FEATURE without an id" };
      return { operation: "delete_feature", payload: { id } };
    }
    case "UPSERT_PRIMER":
      return { operation: "upsert_primer", payload: { primer: payload } };
    case "DELETE_PRIMER": {
      const id = normalizeId(payload);
      if (id === null) return { error: "DELETE_PRIMER without an id" };
      return { operation: "delete_primer", payload: { id } };
    }
    case "UPDATE_CIRCULAR":
      return {
        operation: "set_circular",
        payload: { circular: Boolean(payload) }
      };
    default:
      return { error: `unsupported real action ${action.type}` };
  }
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
 * @param {() => string} [options.getCanonicalSequence] - Returns the
 *   authority's current residues. Required to route the real
 *   `SEQUENCE_DATA_UPDATE` action; without it that action is rejected and
 *   the canonical snapshot is rebroadcast.
 * @param {() => object} [options.getCanonicalSnapshot] - Returns the
 *   authority's current canonical snapshot. Used as a fallback when an
 *   accepted response omits `canonical_snapshot`.
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
  const canonicalSequenceGetter =
    typeof options.getCanonicalSequence === "function"
      ? options.getCanonicalSequence
      : () => null;
  const canonicalSnapshotGetter =
    typeof options.getCanonicalSnapshot === "function"
      ? options.getCanonicalSnapshot
      : () => null;

  function buildRequest(operation, payload) {
    return {
      protocol_version: 1,
      document_id: documentId,
      surface_id: surfaceId,
      transaction_id: makeRequestId(),
      base_revision: revisionGetter(),
      operation,
      payload
    };
  }

  function applyCanonical(response) {
    if (!applySnapshot) return;
    const canonical =
      (response && response.canonical_snapshot) || canonicalSnapshotGetter();
    if (canonical) applySnapshot(canonical);
  }

  function rejectedAction(action, request, response, message) {
    return {
      type: `${action.type}_REJECTED`,
      meta: action.meta,
      payload: {
        originalActionType: action.type,
        request,
        response,
        message
      }
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
        const isSynthetic = SYNTHETIC_MUTATING_ACTIONS.has(action.type);
        const isReal = REAL_MUTATING_ACTIONS.has(action.type);
        const isUndoRedo =
          action.type === "VE_UNDO" || action.type === "VE_REDO";
        if (!isSynthetic && !isReal && !isUndoRedo) {
          return next(action);
        }

        let operation;
        let payload;
        if (isSynthetic) {
          operation = OPERATION_MAP[action.type];
          payload = action.payload || {};
        } else if (isReal) {
          const built = buildRealRequest(action, canonicalSequenceGetter());
          if (built.error) {
            // Unsupported simultaneous mutation: never let the divergent
            // local snapshot overwrite Python's canonical annotations.
            applyCanonical(null);
            return next(rejectedAction(action, null, null, built.error));
          }
          operation = built.operation;
          payload = built.payload;
        } else {
          operation = OPERATION_MAP[action.type];
          payload = {};
        }

        const request = buildRequest(operation, payload);
        let response;
        try {
          response = await submit(request);
        } catch (err) {
          // Treat transport failures as a rejected request so the UI can
          // surface a clear diagnostic and the local state stays untouched.
          const message = `submit() threw: ${
            err && err.message ? err.message : String(err)
          }`;
          if (onResponse) {
            onResponse({
              transaction_id: request.transaction_id,
              status: "rejected",
              new_revision: revisionGetter(),
              canonical_snapshot: null,
              message
            });
          }
          return next(rejectedAction(action, request, null, message));
        }

        if (onResponse) onResponse(response);

        if (isStaleResponse(response) || isForbiddenResponse(response)) {
          applyCanonical(response);
          return next(rejectedAction(action, request, response, ""));
        }

        if (isRejectedResponse(response)) {
          return next(rejectedAction(action, request, response, ""));
        }

        // ACCEPTED.
        if (isUndoRedo) {
          // Python owns the only undo stack. The bridge restores the
          // document and rebroadcasts the canonical state; forwarding the
          // action would let `vectorEditorMiddleware` apply a second, local
          // undo from a stack that is intentionally empty.
          return undefined;
        }
        if (isReal) {
          // Apply the canonical snapshot (annotations included) instead of
          // the divergent local full snapshot.
          applyCanonical(response);
          return undefined;
        }
        // Synthetic actions keep their historical behaviour: the payload is
        // already the precise mutation, so let the reducer apply it.
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
  SYNTHETIC_MUTATING_ACTIONS,
  REAL_MUTATING_ACTIONS,
  OPERATION_MAP,
  REJECTED_TYPES
});

export { REJECTED_TYPES };
