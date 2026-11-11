import { describe, expect, it } from "bun:test";
import { tidyUpSequenceData } from "@teselagen/sequence-utils";

import {
  annotationList,
  buildInsertOrReplaceMutation
} from "./openGeneMutation.js";

describe("openGeneMutation", () => {
  it("normalizes the id-keyed annotation shape produced by tidyUpSequenceData", () => {
    const tidied = tidyUpSequenceData(
      {
        sequence: "ACGT",
        features: [{ name: "inserted feature", start: 0, end: 1 }],
        primers: [{ name: "inserted primer", sequence: "AC" }]
      },
      { annotationsAsObjects: true, provideNewIdsForAnnotations: true }
    );

    // Guard the fixture: this is the shape the paste path actually builds.
    expect(Array.isArray(tidied.features)).toBe(false);
    expect(Array.isArray(tidied.primers)).toBe(false);

    const mutation = buildInsertOrReplaceMutation(tidied, {
      caretPosition: 2
    });

    expect(mutation.operation).toBe("insert_bases");
    expect(mutation.payload).toEqual({ position: 2, residues: "ACGT" });
    expect(mutation.features).toHaveLength(1);
    expect(mutation.features[0].name).toBe("inserted feature");
    expect(mutation.primers).toHaveLength(1);
    expect(mutation.primers[0].name).toBe("inserted primer");
  });

  it("keeps array-shaped fragment annotations", () => {
    const features = [{ id: "f-1", name: "f", start: 0, end: 1 }];
    const primers = [{ id: "p-1", name: "p", sequence: "AC" }];

    expect(annotationList(features)).toBe(features);
    const mutation = buildInsertOrReplaceMutation(
      { sequence: "TT", features, primers },
      { selectionLayer: { start: 1, end: 2 } }
    );

    expect(mutation.operation).toBe("replace_bases");
    expect(mutation.payload).toEqual({
      start: 1,
      end: 3,
      replacement: "TT"
    });
    expect(mutation.features).toBe(features);
    expect(mutation.primers).toBe(primers);
  });

  it("does not add annotation keys when the fragment has none", () => {
    const mutation = buildInsertOrReplaceMutation(
      { sequence: "TT" },
      { caretPosition: 0 }
    );

    expect(mutation).toEqual({
      operation: "insert_bases",
      payload: { position: 0, residues: "TT" }
    });
    expect("features" in mutation).toBe(false);
    expect("primers" in mutation).toBe(false);
  });

  it("returns undefined without a caret or selection anchor", () => {
    expect(
      buildInsertOrReplaceMutation(
        { sequence: "TT", features: [{ id: "f-1" }] },
        { caretPosition: -1, selectionLayer: { start: -1, end: -1 } }
      )
    ).toBeUndefined();
  });
});
