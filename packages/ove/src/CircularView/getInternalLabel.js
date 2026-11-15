import Color from "color";
import React from "react";

export function getInternalLabel({
  ellipsizedName,
  id,
  annotationType,
  revTransform,
  angleAdjust,
  isPart,
  colorToUse,
  textPath,
  locationNumber
}) {
  if (!ellipsizedName) return null;
  const pathId = `${annotationType}${id}${locationNumber ?? ""}`;
  return (
    <>
      <path id={pathId} fill="none" d={textPath.print()}></path>
      <text
        className="veLabelText veCircularViewInternalLabelText ve-monospace-font"
        transform={
          (revTransform || "") + (angleAdjust ? ` rotate(${angleAdjust})` : "")
        }
        // Reason: an internal label sits on the annotation's own fill, so its
        // colour must follow that fill's luminance in both themes. An inline
        // style keeps that choice authoritative over the theme's neutral text
        // rule; a presentation attribute would lose to it.
        style={{
          fill: isPart
            ? "#ac68cc"
            : Color(colorToUse).isDark()
              ? "white"
              : "black"
        }}
        dy={-3}
      >
        <textPath
          textAnchor="middle"
          startOffset="50%"
          xlinkHref={`#${pathId}`}
        >
          {ellipsizedName}
        </textPath>
      </text>
    </>
  );
}
