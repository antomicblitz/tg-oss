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
  "SET_ORIGIN",
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

/**
 * Apply an explicit wire mutation to a sequence, or return null when the
 * operation is not one of the residue operations.
 */
function applyMutation(sequence, mutation) {
  const payload = (mutation && mutation.payload) || {};
  switch (mutation && mutation.operation) {
    case "delete_bases":
      return sequence.slice(0, payload.start) + sequence.slice(payload.end);
    case "insert_bases":
      return (
        sequence.slice(0, payload.position) +
        String(payload.residues || "") +
        sequence.slice(payload.position)
      );
    case "replace_bases":
      return (
        sequence.slice(0, payload.start) +
        String(payload.replacement || "") +
        sequence.slice(payload.end)
      );
    default:
      return null;
  }
}

/**
 * Return true when the prefix/suffix diff identifies a unique edit location.
 *
 * The diff is the rightmost representation of the change. On repeated bases
 * the same result can be produced by shifting the edit left, so the diff
 * cannot be trusted to place feature coordinates. The boundary checks below
 * reject exactly those ambiguous cases; the gesture call sites carry explicit
 * metadata for the edits that matter.
 */
function isUnambiguousMutation(oldSequence, newSequence, mutation) {
  const { start, end, replacement } = mutation;
  const oldLength = oldSequence.length;
  if (replacement === "") {
    // Pure deletion: ambiguous when the deleted base equals the base before
    // the deletion (the edit can slide left).
    if (start > 0 && oldSequence[start - 1] === oldSequence[end - 1]) {
      return false;
    }
    return true;
  }
  if (start === end) {
    // Pure insertion: ambiguous when the inserted base equals the base before
    // or after the insertion (the edit can slide).
    if (
      start > 0 &&
      oldSequence[start - 1] === replacement[replacement.length - 1]
    ) {
      return false;
    }
    if (start < oldLength && oldSequence[start] === replacement[0]) {
      return false;
    }
    return true;
  }
  // Replacement: ambiguous when the replacement can slide across either
  // boundary.
  if (
    start > 0 &&
    oldSequence[start - 1] === replacement[replacement.length - 1]
  ) {
    return false;
  }
  if (end < oldLength && oldSequence[end] === replacement[0]) {
    return false;
  }
  return true;
}

/**
 * Normalize an OVE delete payload to a non-empty array of ids.
 *
 * Stock OVE's `upsertDeleteActionGenerator` accepts a string id, an object
 * with `id`, or an array of either. The wire protocol carries the whole set in
 * one `delete_feature` / `delete_primer` transaction so a multi-select delete
 * is one undo command. Returns null when any id is missing or invalid.
 */
function normalizeIds(payload) {
  const raw = Array.isArray(payload) ? payload : [payload];
  const ids = [];
  for (const item of raw) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof item.id === "string"
          ? item.id
          : null;
    if (!id) return null;
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
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
      // Prefer the explicit mutation the gesture call site attached. It is
      // the only way to place the edit exactly on repeated bases, and it is
      // validated against the actual sequence change so a stale or wrong
      // annotation cannot be trusted.
      const explicit = action.meta && action.meta.openGeneMutation;
      if (explicit) {
        if (explicit.compound) {
          return {
            error:
              explicit.reason ||
              "compound SEQUENCE_DATA_UPDATE with annotation deltas is not supported"
          };
        }
        if (explicit.wraps) {
          return {
            error:
              "wrapping delete_bases across the origin is not supported by " +
              "the wire protocol"
          };
        }
        const applied = applyMutation(canonicalSequence, explicit);
        if (applied === null) {
          return {
            error: `unsupported explicit operation ${explicit.operation}`
          };
        }
        if (applied !== newSequence) {
          return {
            error:
              "explicit mutation does not match the local sequence change; " +
              "refusing to apply a divergent edit"
          };
        }
        return { operation: explicit.operation, payload: explicit.payload };
      }
      if (newSequence === canonicalSequence) {
        return {
          error:
            "SEQUENCE_DATA_UPDATE changed annotations only; route annotation " +
            "edits through UPSERT_FEATURE / DELETE_FEATURE / UPSERT_PRIMER / " +
            "DELETE_PRIMER"
        };
      }
      // Reason: a whole-molecule reverse complement is unambiguous from the
      // canonical sequence, so route it to the dedicated operation. The
      // editing seam flips feature/marker coordinates and strands; a plain
      // `replace_bases` would leave them wrong.
      if (reverseComplement(canonicalSequence) === newSequence) {
        return { operation: "reverse_complement", payload: {} };
      }
      // Reason: an origin rotation is ambiguous on repeated residues, so the
      // OVE command dispatches an explicit `SET_ORIGIN` action first and the
      // middleware swallows the follow-up full snapshot. A bare rotation that
      // reaches here is an unclassified simultaneous change; reject it rather
      // than guess the origin.
      if (isRotation(canonicalSequence, newSequence)) {
        return {
          error:
            "SEQUENCE_DATA_UPDATE is an origin rotation without an explicit " +
            "SET_ORIGIN action; the origin cannot be inferred safely on " +
            "repeated residues"
        };
      }
      const mutation = diffResidues(canonicalSequence, newSequence);
      if (!isUnambiguousMutation(canonicalSequence, newSequence, mutation)) {
        return {
          error:
            "unannotated SEQUENCE_DATA_UPDATE is ambiguous on repeated bases; " +
            "the gesture must carry explicit openGeneMutation metadata"
        };
      }
      return { operation: "replace_bases", payload: mutation };
    }
    case "SET_ORIGIN": {
      const newOrigin =
        payload && typeof payload.new_origin === "number"
          ? payload.new_origin
          : null;
      if (newOrigin === null) {
        return { error: "SET_ORIGIN without a numeric new_origin" };
      }
      return { operation: "rotate_origin", payload: { new_origin: newOrigin } };
    }
    case "UPSERT_FEATURE":
      return { operation: "upsert_feature", payload: { feature: payload } };
    case "DELETE_FEATURE": {
      const ids = normalizeIds(payload);
      if (ids === null) return { error: "DELETE_FEATURE without valid ids" };
      return { operation: "delete_feature", payload: { ids } };
    }
    case "UPSERT_PRIMER":
      return { operation: "upsert_primer", payload: { primer: payload } };
    case "DELETE_PRIMER": {
      const ids = normalizeIds(payload);
      if (ids === null) return { error: "DELETE_PRIMER without valid ids" };
      return { operation: "delete_primer", payload: { ids } };
    }
    case "UPDATE_CIRCULAR": {
      // Reason: a confirmed linearize+truncate carries the user's chosen
      // annotation replacement in the action meta. Send it in the same
      // `set_circular` transaction so topology and annotations change
      // atomically (one undo command) instead of a rejected annotation-only
      // snapshot followed by a topology toggle that restores the old
      // annotations.
      const truncation = action.meta && action.meta.openGeneTruncation;
      const requestPayload = { circular: Boolean(payload) };
      if (truncation) {
        if (Array.isArray(truncation.features)) {
          requestPayload.features = truncation.features;
        }
        if (Array.isArray(truncation.primers)) {
          requestPayload.primers = truncation.primers;
        }
      }
      return { operation: "set_circular", payload: requestPayload };
    }
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
  // Reason: the OVE Set Origin command dispatches an explicit `SET_ORIGIN`
  // action and then the local `SEQUENCE_DATA_UPDATE` that rotates the
  // sequence. The explicit action is authoritative; the follow-up full
  // snapshot is the same rotation and must not be submitted a second time (or
  // rejected as an unclassified rotation). The flag is consumed by the next
  // `SEQUENCE_DATA_UPDATE` and cleared on a microtask so a command that never
  // emits one cannot swallow an unrelated later edit.
  let suppressNextSequenceDataUpdate = false;

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
        if (
          action.type === "SEQUENCE_DATA_UPDATE" &&
          suppressNextSequenceDataUpdate
        ) {
          // The explicit SET_ORIGIN already submitted the rotation and the
          // canonical snapshot is applied; this local full snapshot is the
          // same change and must not be routed again.
          suppressNextSequenceDataUpdate = false;
          return undefined;
        }
        const isSynthetic = SYNTHETIC_MUTATING_ACTIONS.has(action.type);
        const isReal = REAL_MUTATING_ACTIONS.has(action.type);
        const isUndoRedo =
          action.type === "VE_UNDO" || action.type === "VE_REDO";
        if (!isSynthetic && !isReal && !isUndoRedo) {
          return next(action);
        }
        if (action.type === "SET_ORIGIN") {
          suppressNextSequenceDataUpdate = true;
          // Clear on a microtask so a command that never emits the follow-up
          // snapshot cannot swallow an unrelated later edit.
          Promise.resolve().then(() => {
            suppressNextSequenceDataUpdate = false;
          });
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
