/**
 * Build the explicit mutation metadata the external-authority middleware
 * needs to place an insert/replace edit on the canonical sequence.
 *
 * The gesture (not the prefix/suffix diff) knows the caret or selection, so
 * this metadata is the only way to avoid repeated-base ambiguity. Fragment
 * annotations are carried with the residue mutation so Python can apply both
 * in one transaction; they are deliberately *not* the already-remapped full
 * molecule snapshot.
 */

/**
 * Return annotation entries as an array.
 *
 * `tidyUpSequenceData(..., { annotationsAsObjects: true })` returns an
 * id-keyed object, while raw fragments and test fixtures usually use arrays.
 * The wire protocol always carries arrays.
 *
 * @param {Array|object|undefined} annotations
 * @returns {Array}
 */
export function annotationList(annotations) {
  if (Array.isArray(annotations)) return annotations;
  if (annotations && typeof annotations === "object") {
    return Object.values(annotations);
  }
  return [];
}

/**
 * Build an `insert_bases` or `replace_bases` metadata object for one gesture.
 *
 * @param {object} seqDataToInsert - Fragment being inserted (already tidied
 *   for the destination molecule).
 * @param {{caretPosition?: number, selectionLayer?: object}} gesture
 * @returns {object|undefined} `openGeneMutation` metadata, or undefined when
 *   the gesture has no caret/selection to anchor the edit.
 */
export function buildInsertOrReplaceMutation(seqDataToInsert, gesture = {}) {
  const { caretPosition, selectionLayer } = gesture;
  const insertedResidues = (seqDataToInsert && seqDataToInsert.sequence) || "";
  let openGeneMutation;
  if (caretPosition > -1) {
    openGeneMutation = {
      operation: "insert_bases",
      payload: { position: caretPosition, residues: insertedResidues }
    };
  } else if (selectionLayer && selectionLayer.start >= 0) {
    openGeneMutation = {
      operation: "replace_bases",
      payload: {
        start: selectionLayer.start,
        end: selectionLayer.end + 1,
        replacement: insertedResidues
      }
    };
  }
  if (!openGeneMutation) return undefined;

  const features = annotationList(seqDataToInsert && seqDataToInsert.features);
  const primers = annotationList(seqDataToInsert && seqDataToInsert.primers);
  if (features.length > 0 || primers.length > 0) {
    openGeneMutation.features = features;
    openGeneMutation.primers = primers;
  }
  return openGeneMutation;
}
