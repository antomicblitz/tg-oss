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
export function createMockAuthority(options: {
    initial: object;
    documentId: string;
    startingRevision?: number | undefined;
}): {
    submit: (req: object) => Promise<object>;
    snapshot: () => object;
    revision: () => number;
    history: () => object[];
    reset: () => void;
};
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
export function makeRequest(args: {
    documentId: string;
    surfaceId: string;
    baseRevision: number;
    operation: string;
    payload?: object | undefined;
    transactionId?: string | undefined;
}): object;
export const OperationKind: Readonly<{
    REPLACE_BASES: "replace_bases";
    INSERT_BASES: "insert_bases";
    DELETE_BASES: "delete_bases";
    REVERSE_COMPLEMENT: "reverse_complement";
    SELECTION_UPDATE: "selection_update";
    CARET_UPDATE: "caret_update";
    UPSERT_FEATURE: "upsert_feature";
    DELETE_FEATURE: "delete_feature";
    UPSERT_PRIMER: "upsert_primer";
    DELETE_PRIMER: "delete_primer";
    SET_CIRCULAR: "set_circular";
    ROTATE_ORIGIN: "rotate_origin";
    REQUEST_UNDO: "request_undo";
    REQUEST_REDO: "request_redo";
    ALIGN: "align";
}>;
export const AckStatus: Readonly<{
    ACCEPTED: "accepted";
    REJECTED: "rejected";
    STALE: "stale";
    FORBIDDEN: "forbidden";
}>;
