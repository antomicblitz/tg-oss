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
export function diffResidues(oldSequence: string, newSequence: string): {
    start: number;
    end: number;
    replacement: string;
};
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
export function createExternalAuthorityMiddleware(options: {
    submit: (req: object) => Promise<object>;
    documentId: string;
    surfaceId: string;
    revision?: (() => number) | undefined;
    getCanonicalSequence?: (() => string) | undefined;
    getCanonicalSnapshot?: (() => object) | undefined;
    applySnapshot?: ((snapshot: object) => void) | undefined;
    onResponse?: ((response: object) => void) | undefined;
}): Function;
/**
 * Test helper — convenience export of the constants so tests can build
 * deterministic inputs without re-deriving the wire-format mapping.
 */
export const EXTERNAL_AUTHORITY_CONSTANTS: Readonly<{
    MUTATING_ACTIONS: Set<string>;
    SYNTHETIC_MUTATING_ACTIONS: Set<string>;
    REAL_MUTATING_ACTIONS: Set<string>;
    OPERATION_MAP: Readonly<{
        ADD_BPS: "insert_bases";
        DELETE_BPS: "delete_bases";
        REPLACE_BPS: "replace_bases";
        FEATURE_UPSERT: "upsert_feature";
        FEATURE_DELETE: "delete_feature";
        PRIMER_UPSERT: "upsert_primer";
        PRIMER_DELETE: "delete_primer";
        SET_CIRCULAR: "set_circular";
        ROTATE_ORIGIN: "rotate_origin";
        VE_UNDO: "request_undo";
        VE_REDO: "request_redo";
    }>;
    REJECTED_TYPES: Set<string>;
}>;
export const REJECTED_TYPES: Set<string>;
