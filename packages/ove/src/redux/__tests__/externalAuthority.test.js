// externalAuthority.test.js
//
// Tests for the OVE `externalAuthority` middleware. Drives the middleware
// against the Node mock backend (`mockAuthority.js`) to prove the wire
// protocol round-trips: accepted mutations apply locally, stale requests
// rebase to the canonical snapshot, rejected/forbidden mutations surface
// a *_REJECTED action with the diagnostic payload, and transport errors
// do not corrupt local state.
//
// Reference: docs/plans/ove-sequence-workspace-migration.md (slice 1a).

import assert from "assert";
import { describe, expect, it } from "bun:test";

import {
  createExternalAuthorityMiddleware,
  diffResidues,
  EXTERNAL_AUTHORITY_CONSTANTS
} from "../externalAuthority.js";
import {
  createMockAuthority,
  makeRequest
} from "../__mocks__/mockAuthority.js";

const { MUTATING_ACTIONS } = EXTERNAL_AUTHORITY_CONSTANTS;

// --- Tiny Redux stub -------------------------------------------------------
//
// The middleware only needs `next` (the next dispatcher) and a way to read
// the store's current state. We don't need the full Redux API for these
// tests — a minimal store suffices.

function makeStoreStub() {
  let state = { VectorEditor: {} };
  const subscribers = [];
  return {
    getState: () => state,
    dispatch: action => {
      // Mimic how the middleware calls `next(action)`.
      return action;
    },
    replaceState: next => {
      state = next;
      for (const fn of subscribers) fn();
    },
    subscribe: fn => {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }
  };
}

// Track the actions that flowed through `next()` so tests can assert on
// what reached the local reducer.
function recordingNext() {
  const seen = [];
  const next = action => {
    seen.push(action);
    return action;
  };
  return { next, seen };
}

// ---------------------------------------------------------------------------

describe("createExternalAuthorityMiddleware", () => {
  it("passes non-mutating actions through unchanged", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const calls = [];
    const submit = async req => {
      calls.push(req);
      return authority.submit(req);
    };
    const store = makeStoreStub();
    const mw = createExternalAuthorityMiddleware({
      submit,
      documentId: "doc-1",
      surfaceId: "map"
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SELECTION_LAYER_UPDATE",
      payload: { start: 1, end: 2 }
    });

    expect(calls.length).toBe(0); // never submitted
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("SELECTION_LAYER_UPDATE");
  });

  it("submits a REPLACE_BPS mutation and applies locally on ACCEPTED", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGTACGT", circular: true }
    });
    const responses = [];
    const applySnapshot = snap => responses.push({ kind: "snapshot", snap });
    const store = makeStoreStub();
    const mw = createExternalAuthorityMiddleware({
      submit: authority.submit,
      documentId: "doc-1",
      surfaceId: "map",
      applySnapshot,
      onResponse: r => responses.push({ kind: "response", r })
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "REPLACE_BPS",
      meta: { editorName: "main" },
      payload: { start: 0, end: 4, replacement: "TTTT" }
    });

    // ACCEPTED — original action reaches `next`.
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("REPLACE_BPS");
    // No snapshot was applied (only STALE carries one).
    expect(responses.filter(x => x.kind === "snapshot").length).toBe(0);
    expect(authority.revision()).toBe(1);
    expect(authority.snapshot().sequence).toBe("TTTTACGT");
  });

  it("emits REPLACE_BPS_REJECTED with diagnostic on STALE and rebases via snapshot", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    // Simulate OVE falling behind: bump the authority to revision 5.
    authority.reset({ sequence: "GGGG", circular: false }, 5);

    const store = makeStoreStub();
    const applied = [];
    const mw = createExternalAuthorityMiddleware({
      submit: authority.submit,
      documentId: "doc-1",
      surfaceId: "map",
      revision: () => 0,
      applySnapshot: snap => applied.push(snap)
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "REPLACE_BPS",
      meta: { editorName: "main" },
      payload: { start: 0, end: 4, replacement: "TTTT" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("REPLACE_BPS_REJECTED");
    expect(seen[0].payload.originalActionType).toBe("REPLACE_BPS");
    expect(seen[0].payload.response.status).toBe("stale");
    expect(seen[0].payload.response.canonical_snapshot.revision).toBe(5);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("GGGG");
    // Authority state untouched.
    expect(authority.snapshot().sequence).toBe("GGGG");
  });

  it("emits a *_REJECTED action when the authority returns REJECTED", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const store = makeStoreStub();
    const mw = createExternalAuthorityMiddleware({
      submit: authority.submit,
      documentId: "doc-1",
      surfaceId: "map"
    })(store);
    const { next, seen } = recordingNext();

    // Out-of-bounds replace.
    await mw(next)({
      type: "REPLACE_BPS",
      meta: { editorName: "main" },
      payload: { start: 0, end: 100, replacement: "TTTT" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("REPLACE_BPS_REJECTED");
    expect(seen[0].payload.response.status).toBe("rejected");
    expect(seen[0].payload.response.message).toMatch(/out of bounds/);
    expect(authority.revision()).toBe(0);
  });

  it("emits a *_REJECTED action on FORBIDDEN (read-only mode)", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    authority.setForbidden(true);
    const store = makeStoreStub();
    const mw = createExternalAuthorityMiddleware({
      submit: authority.submit,
      documentId: "doc-1",
      surfaceId: "map"
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "ADD_BPS",
      meta: { editorName: "main" },
      payload: { position: 1, sequence: "AAA" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("ADD_BPS_REJECTED");
    expect(seen[0].payload.response.status).toBe("forbidden");
    expect(authority.revision()).toBe(0);
  });

  it("treats a thrown submit() as a REJECTED with a transport message", async () => {
    const store = makeStoreStub();
    const mw = createExternalAuthorityMiddleware({
      submit: async () => {
        throw new Error("connection refused");
      },
      documentId: "doc-1",
      surfaceId: "map"
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "REPLACE_BPS",
      meta: { editorName: "main" },
      payload: { start: 0, end: 4, replacement: "TTTT" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("REPLACE_BPS_REJECTED");
    expect(seen[0].payload.message).toMatch(/connection refused/);
  });

  it("routes VE_UNDO / VE_REDO through REQUEST_UNDO / REQUEST_REDO without a local undo", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    // Apply one accepted edit so the authority has been exercised.
    authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 0,
        operation: "replace_bases",
        payload: { start: 0, end: 4, replacement: "TTTT" }
      })
    );
    expect(authority.revision()).toBe(1);

    const operations = [];
    const store = makeStoreStub();
    const mw = createExternalAuthorityMiddleware({
      submit: async request => {
        operations.push(request.operation);
        return authority.submit(request);
      },
      documentId: "doc-1",
      surfaceId: "map"
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({ type: "VE_UNDO", meta: { editorName: "main" } });
    await mw(next)({ type: "VE_REDO", meta: { editorName: "main" } });

    // Python owns the only undo stack: the requests go out, but the local
    // vectorEditorMiddleware must not see VE_UNDO / VE_REDO and pop its own
    // (empty) stack.
    expect(operations).toEqual(["request_undo", "request_redo"]);
    expect(seen).toEqual([]);
    // Authority has not bumped revision for undo/redo (per mock contract).
    expect(authority.revision()).toBe(1);
  });

  it("chains multiple mutations; revision advances correctly", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "AAAA", circular: true }
    });
    const store = makeStoreStub();
    let localRevision = 0;
    const mw = createExternalAuthorityMiddleware({
      submit: authority.submit,
      documentId: "doc-1",
      surfaceId: "map",
      revision: () => localRevision
    })(store);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "REPLACE_BPS",
      payload: { start: 0, end: 4, replacement: "CCCC" }
    });
    localRevision = authority.revision();

    await mw(next)({
      type: "ADD_BPS",
      payload: { position: 4, sequence: "GGGG" }
    });
    localRevision = authority.revision();

    await mw(next)({
      type: "SET_CIRCULAR",
      payload: { circular: false }
    });

    expect(seen.length).toBe(3);
    expect(seen.every(a => !a.type.endsWith("_REJECTED"))).toBe(true);
    expect(authority.revision()).toBe(3);
    expect(authority.snapshot().sequence).toBe("CCCCGGGG");
    expect(authority.snapshot().circular).toBe(false);
  });

  it("rejects every mutating action kind in MUTATING_ACTIONS", () => {
    // Sanity check: the action whitelist covers the operations the bridge
    // protocol supports. If a new operation is added to the protocol, this
    // assertion will fail and force the maintainer to update the
    // middleware's mapping.
    const expected = new Set([
      "ADD_BPS",
      "DELETE_BPS",
      "REPLACE_BPS",
      "FEATURE_UPSERT",
      "FEATURE_DELETE",
      "PRIMER_UPSERT",
      "PRIMER_DELETE",
      "SET_CIRCULAR",
      "ROTATE_ORIGIN"
    ]);
    for (const action of expected) {
      expect(MUTATING_ACTIONS.has(action)).toBe(true);
    }
  });

  it("requires submit, documentId, surfaceId", () => {
    assert.throws(
      () => createExternalAuthorityMiddleware({}),
      /requires options.submit function/
    );
    assert.throws(
      () =>
        createExternalAuthorityMiddleware({
          submit: async () => ({}),
          documentId: "",
          surfaceId: "map"
        }),
      /requires options.documentId/
    );
    assert.throws(
      () =>
        createExternalAuthorityMiddleware({
          submit: async () => ({}),
          documentId: "doc-1",
          surfaceId: ""
        }),
      /requires options.surfaceId/
    );
  });
});

describe("diffResidues", () => {
  it("derives a pure insertion", () => {
    expect(diffResidues("ACGT", "ACGGGT")).toEqual({
      start: 3,
      end: 3,
      replacement: "GG"
    });
  });

  it("derives a pure deletion", () => {
    expect(diffResidues("ACGTACGT", "ACGT")).toEqual({
      start: 4,
      end: 8,
      replacement: ""
    });
  });

  it("derives a substitution", () => {
    expect(diffResidues("ACGT", "ATGT")).toEqual({
      start: 1,
      end: 2,
      replacement: "T"
    });
  });

  it("returns an empty mutation for identical sequences", () => {
    expect(diffResidues("ACGT", "ACGT")).toEqual({
      start: 4,
      end: 4,
      replacement: ""
    });
  });
});

describe("real OVE action routing", () => {
  function makeRealActionMiddleware(authority, extra = {}) {
    const applied = [];
    const mw = createExternalAuthorityMiddleware({
      submit: authority.submit,
      documentId: "doc-1",
      surfaceId: "map",
      revision: () => authority.revision(),
      getCanonicalSequence: () => authority.snapshot().sequence,
      getCanonicalSnapshot: () => authority.snapshot(),
      applySnapshot: snap => applied.push(snap),
      ...extra
    })(makeStoreStub());
    return { mw, applied };
  }

  it("routes an explicit delete_bases SEQUENCE_DATA_UPDATE and applies the canonical snapshot", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGTACGT", circular: true }
    });
    const operations = [];
    const { mw, applied } = makeRealActionMiddleware(authority, {
      submit: async request => {
        operations.push(request);
        return authority.submit(request);
      }
    });
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: {
        editorName: "main",
        openGeneMutation: {
          operation: "delete_bases",
          payload: { start: 4, end: 8 }
        }
      },
      payload: { sequence: "ACGT", circular: true }
    });

    // The local full snapshot is NOT forwarded; the canonical one is applied.
    expect(seen.length).toBe(0);
    expect(operations[0].operation).toBe("delete_bases");
    expect(operations[0].payload).toEqual({ start: 4, end: 8 });
    expect(authority.revision()).toBe(1);
    expect(authority.snapshot().sequence).toBe("ACGT");
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("ACGT");
  });

  it("uses the explicit delete range on repeated bases instead of the diff heuristic", async () => {
    // Deleting index 1 of AAAAA and index 4 both yield AAAA. The gesture
    // metadata must win so feature coordinates are remapped at the real edit.
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "AAAAA", circular: false }
    });
    const operations = [];
    const { mw } = makeRealActionMiddleware(authority, {
      submit: async request => {
        operations.push(request);
        return authority.submit(request);
      }
    });
    const { next } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: {
        editorName: "main",
        openGeneMutation: {
          operation: "delete_bases",
          payload: { start: 1, end: 2 }
        }
      },
      payload: { sequence: "AAAA" }
    });

    expect(operations[0].operation).toBe("delete_bases");
    expect(operations[0].payload).toEqual({ start: 1, end: 2 });
    expect(authority.snapshot().sequence).toBe("AAAA");
  });

  it("rejects an unannotated repeated-base deletion instead of guessing the index", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "AAAAA", circular: false }
    });
    const { mw, applied } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: { editorName: "main" },
      payload: { sequence: "AAAA" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("SEQUENCE_DATA_UPDATE_REJECTED");
    expect(seen[0].payload.message).toMatch(/ambiguous on repeated bases/);
    expect(authority.revision()).toBe(0);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("AAAAA");
  });

  it("rejects explicit metadata that does not match the local sequence change", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "AAAAA", circular: false }
    });
    const { mw, applied } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: {
        editorName: "main",
        openGeneMutation: {
          operation: "delete_bases",
          payload: { start: 0, end: 2 }
        }
      },
      payload: { sequence: "AAAA" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("SEQUENCE_DATA_UPDATE_REJECTED");
    expect(seen[0].payload.message).toMatch(/does not match/);
    expect(authority.revision()).toBe(0);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("AAAAA");
  });

  it("rejects a compound fragment insert with annotation deltas", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const { mw, applied } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: {
        editorName: "main",
        openGeneMutation: {
          operation: "insert_bases",
          payload: { position: 2, residues: "TT" },
          compound: true,
          reason: "fragment insert with annotation deltas"
        }
      },
      payload: { sequence: "ACTTGT" }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("SEQUENCE_DATA_UPDATE_REJECTED");
    expect(seen[0].payload.message).toMatch(/fragment insert/);
    expect(authority.revision()).toBe(0);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("ACGT");
  });

  it("rejects an annotation-only SEQUENCE_DATA_UPDATE and rebroadcasts canonical", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const { mw, applied } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: { editorName: "main" },
      payload: {
        sequence: "ACGT",
        features: [{ id: "f-1", start: 0, end: 1, name: "x" }]
      }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("SEQUENCE_DATA_UPDATE_REJECTED");
    expect(seen[0].payload.message).toMatch(/annotations only/);
    expect(authority.revision()).toBe(0);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("ACGT");
  });

  it("routes a reverse-complement SEQUENCE_DATA_UPDATE as reverse_complement", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "AAGC", circular: false }
    });
    const operations = [];
    const { mw, applied } = makeRealActionMiddleware(authority, {
      submit: async request => {
        operations.push(request.operation);
        return authority.submit(request);
      }
    });
    const { next, seen } = recordingNext();

    // Reverse complement of AAGC is GCTT.
    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: { editorName: "main" },
      payload: { sequence: "GCTT" }
    });

    expect(operations).toEqual(["reverse_complement"]);
    expect(seen.length).toBe(0);
    expect(authority.revision()).toBe(1);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("GCTT");
  });

  it("routes SET_ORIGIN as rotate_origin and swallows the follow-up snapshot", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGTACGT", circular: true }
    });
    const operations = [];
    const { mw, applied } = makeRealActionMiddleware(authority, {
      submit: async request => {
        operations.push(request.operation);
        return authority.submit(request);
      }
    });
    const { next, seen } = recordingNext();

    // The OVE command dispatches both synchronously: the explicit origin
    // action, then the local rotated full snapshot.
    const originPromise = mw(next)({
      type: "SET_ORIGIN",
      meta: { editorName: "main" },
      payload: { new_origin: 2 }
    });
    const snapshotPromise = mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: { editorName: "main" },
      payload: { sequence: "GTACGTAC", circular: true }
    });
    await Promise.all([originPromise, snapshotPromise]);

    expect(operations).toEqual(["rotate_origin"]);
    expect(seen.length).toBe(0);
    expect(authority.revision()).toBe(1);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("GTACGTAC");
  });

  it("rejects a bare origin-rotation snapshot without an explicit SET_ORIGIN", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGTACGT", circular: true }
    });
    const { mw, applied } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "SEQUENCE_DATA_UPDATE",
      meta: { editorName: "main" },
      payload: { sequence: "GTACGTAC", circular: true }
    });

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("SEQUENCE_DATA_UPDATE_REJECTED");
    expect(seen[0].payload.message).toMatch(/SET_ORIGIN/);
    expect(authority.revision()).toBe(0);
    expect(applied.length).toBe(1);
    expect(applied[0].sequence).toBe("ACGTACGT");
  });

  it("routes UPSERT_FEATURE and applies the canonical snapshot", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const { mw, applied } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({
      type: "UPSERT_FEATURE",
      meta: { editorName: "main" },
      payload: { id: "f-1", start: 0, end: 3, name: "promoter" }
    });

    expect(seen.length).toBe(0);
    expect(authority.revision()).toBe(1);
    expect(authority.snapshot().features).toHaveLength(1);
    expect(applied.length).toBe(1);
    expect(applied[0].features).toHaveLength(1);
  });

  it("routes DELETE_FEATURE by id", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: {
        sequence: "ACGT",
        circular: false,
        features: [{ id: "f-1", start: 0, end: 3, name: "promoter" }]
      }
    });
    const { mw } = makeRealActionMiddleware(authority);
    const { next } = recordingNext();

    await mw(next)({
      type: "DELETE_FEATURE",
      meta: { editorName: "main" },
      payload: "f-1"
    });

    expect(authority.revision()).toBe(1);
    expect(authority.snapshot().features).toHaveLength(0);
  });

  it("routes UPDATE_CIRCULAR as set_circular", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: true }
    });
    const { mw } = makeRealActionMiddleware(authority);
    const { next } = recordingNext();

    await mw(next)({
      type: "UPDATE_CIRCULAR",
      meta: { editorName: "main" },
      payload: false
    });

    expect(authority.revision()).toBe(1);
    expect(authority.snapshot().circular).toBe(false);
  });

  it("swallows VE_UNDO so the local undo middleware cannot run first", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const { mw } = makeRealActionMiddleware(authority);
    const { next, seen } = recordingNext();

    await mw(next)({ type: "VE_UNDO", meta: { editorName: "main" } });

    // Python owns the undo stack; the action must not reach the local
    // vectorEditorMiddleware (which would pop its own stack).
    expect(seen.length).toBe(0);
  });
});

describe("createMockAuthority", () => {
  it("round-trips: insert + delete + replace + rotate + set_circular", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGTACGT", circular: true }
    });

    // Insert 4 bp at position 4.
    let r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 0,
        operation: "insert_bases",
        payload: { position: 4, sequence: "NNNN" }
      })
    );
    expect(r.status).toBe("accepted");
    expect(authority.snapshot().sequence).toBe("ACGTNNNNACGT");
    expect(authority.revision()).toBe(1);

    // Replace the inserted NNNN with TTTT.
    r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 1,
        operation: "replace_bases",
        payload: { start: 4, end: 8, replacement: "TTTT" }
      })
    );
    expect(r.status).toBe("accepted");
    expect(authority.snapshot().sequence).toBe("ACGTTTTTACGT");
    expect(authority.revision()).toBe(2);

    // Set linear.
    r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 2,
        operation: "set_circular",
        payload: { circular: false }
      })
    );
    expect(r.status).toBe("accepted");
    expect(authority.snapshot().circular).toBe(false);
    expect(authority.revision()).toBe(3);

    // Rotate origin to position 4. The sequence is 12 bp; rotating by 4
    // yields the original 12 characters reordered.
    r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 3,
        operation: "rotate_origin",
        payload: { origin: 4 }
      })
    );
    expect(r.status).toBe("accepted");
    // ACGTTTTTACGT rotated by 4: chars [4..12) + chars [0..4)
    // = TTTTACGT + ACGT = TTTTACGTACGT (12 chars)
    expect(authority.snapshot().sequence).toBe("TTTTACGTACGT");
    expect(authority.snapshot().sequence).toHaveLength(12);
    expect(authority.revision()).toBe(4);
  });

  it("rejects protocol_version mismatch", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const req = makeRequest({
      documentId: "doc-1",
      surfaceId: "map",
      baseRevision: 0,
      operation: "selection_update"
    });
    req.protocol_version = 99;
    await expect(authority.submit(req)).rejects.toThrow(/protocol_version/);
  });

  it("rejects document_id mismatch", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const req = makeRequest({
      documentId: "doc-other",
      surfaceId: "map",
      baseRevision: 0,
      operation: "selection_update"
    });
    await expect(authority.submit(req)).rejects.toThrow(/document_id/);
  });

  it("upsert_feature: insert then update then delete", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    const feature = { id: "f-1", start: 0, end: 4, name: "promoter" };

    let r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 0,
        operation: "upsert_feature",
        payload: { feature }
      })
    );
    expect(r.status).toBe("accepted");
    expect(authority.snapshot().features).toHaveLength(1);

    r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 1,
        operation: "upsert_feature",
        payload: { feature: { ...feature, name: "promoter-renamed" } }
      })
    );
    expect(r.status).toBe("accepted");
    expect(authority.snapshot().features[0].name).toBe("promoter-renamed");

    r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 2,
        operation: "delete_feature",
        payload: { id: "f-1" }
      })
    );
    expect(r.status).toBe("accepted");
    expect(authority.snapshot().features).toHaveLength(0);

    r = await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 3,
        operation: "delete_feature",
        payload: { id: "f-missing" }
      })
    );
    expect(r.status).toBe("rejected");
  });

  it("records every accepted transaction in history", async () => {
    const authority = createMockAuthority({
      documentId: "doc-1",
      initial: { sequence: "ACGT", circular: false }
    });
    await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 0,
        operation: "replace_bases",
        payload: { start: 0, end: 4, replacement: "TTTT" }
      })
    );
    await authority.submit(
      makeRequest({
        documentId: "doc-1",
        surfaceId: "map",
        baseRevision: 1,
        operation: "set_circular",
        payload: { circular: true }
      })
    );
    const h = authority.history();
    expect(h).toHaveLength(2);
    expect(h[0].op).toBe("replace_bases");
    expect(h[0].revision).toBe(1);
    expect(h[1].op).toBe("set_circular");
    expect(h[1].revision).toBe(2);
  });
});
