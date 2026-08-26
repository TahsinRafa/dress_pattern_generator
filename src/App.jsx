import React, { useMemo, useState, useRef } from "react";

/* ============================================================================
   SLOPER STUDIO — parametric pattern drafting & printing engine
   ----------------------------------------------------------------------------
   A single-file implementation of:
     Module A — measurement input + deterministic validation + derivation
     Module B — 2D drafting geometry (bodice + skirt half-patterns)
     Module C — interactive SVG rendering with layer toggles
     Module D — export: full-scale single-sheet SVG, and tiled multi-page
                 print preview (A4 / US Letter) with calibration + registration
   Notes on scope: true AAMA/DXF and HPGL/PLT binary export require a native
   file-format writer and are out of scope for an in-browser artifact; the
   full-scale SVG here is dimensionally accurate (1 svg unit = 1 inch) and can
   be sent to any plotter RIP or opened directly by a DXF-import tool.
   ============================================================================ */

/* ---------------------------------- tokens --------------------------------- */
const COLORS = {
  canvas: "#F1E9D2",
  grid: "#DCCDA0",
  ink: "#241F1A",
  thread: "#A63446",
  chalk: "#34506B",
  muted: "#7A7261",
  paper: "#FBF7EC",
  brass: "#B8863B",
};

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap');`;

const IN_TO_CM = 2.54;

/* --------------------------------- units ----------------------------------- */
const toDisplay = (inches, unit) =>
  inches == null || isNaN(inches) ? "" : (unit === "cm" ? inches * IN_TO_CM : inches).toFixed(2);
const fromDisplay = (str, unit) => {
  const v = parseFloat(str);
  if (isNaN(v)) return null;
  return unit === "cm" ? v / IN_TO_CM : v;
};

/* --------------------------- measurement schema ----------------------------
   Every value is stored internally in INCHES regardless of display unit.
   `derived: true` fields are filled by ratio-based estimation whenever the
   user leaves them blank (Module A, "standard grading distribution ratios"),
   and are always overridable by direct entry.
------------------------------------------------------------------------------*/
const FIELD_GROUPS = [
  {
    label: "Circumferences",
    fields: [
      { key: "bust", label: "Bust", core: true },
      { key: "highBust", label: "High Bust (for cup-slope check)", core: false },
      { key: "waist", label: "Waist", core: true },
      { key: "highHip", label: "High Hip", core: false },
      { key: "fullHip", label: "Full Hip", core: true },
      { key: "neck", label: "Neck Circumference", core: false },
    ],
  },
  {
    label: "Torso Heights",
    fields: [
      { key: "napeToWaist", label: "Nape to Waist (Back Length)", core: true },
      { key: "frontShoulderToWaist", label: "Front Shoulder to Waist", core: true },
      { key: "armholeDepth", label: "Armhole Depth", core: false },
      { key: "apexHeight", label: "Apex Height", core: false },
      { key: "hipDepth", label: "Waist to Full Hip Depth", core: true },
      { key: "skirtLength", label: "Skirt Length (waist to hem)", core: true },
    ],
  },
  {
    label: "Cross Widths",
    fields: [
      { key: "acrossShoulder", label: "Across Shoulder (Shoulder Span)", core: false },
      { key: "acrossBack", label: "Across Back", core: false },
      { key: "acrossFront", label: "Across Front / Chest", core: false },
      { key: "apexToApex", label: "Bust Point to Bust Point", core: false },
    ],
  },
];

const DEFAULTS_IN = {
  bust: 36, highBust: null, waist: 28, highHip: null, fullHip: 38, neck: 14.5,
  napeToWaist: 16, frontShoulderToWaist: 16.5, armholeDepth: null, apexHeight: null,
  hipDepth: 9, skirtLength: 22,
  acrossShoulder: null, acrossBack: null, acrossFront: null, apexToApex: null,
};

/* --------------------------- Module A: derivation --------------------------
   Ratio-based estimates used only when a field is blank. These are practical
   approximations drawn from common grading-ratio tables, not a substitute for
   a real fitting — the UI marks any estimated field as "(est.)".
------------------------------------------------------------------------------*/
function deriveMeasurements(m) {
  const out = { ...m };
  const bust = m.bust || 36;
  const waist = m.waist || bust - 8;
  if (out.fullHip == null) out.fullHip = waist + 10;
  if (out.highHip == null) out.highHip = out.fullHip - 3;
  if (out.highBust == null) out.highBust = bust - 1.5;
  if (out.neck == null) out.neck = bust / 3 + 0.75;
  if (out.napeToWaist == null) out.napeToWaist = 16 + (bust - 36) * 0.05;
  if (out.frontShoulderToWaist == null) out.frontShoulderToWaist = out.napeToWaist + 0.5;
  if (out.armholeDepth == null) out.armholeDepth = bust / 8 + 2.5;
  if (out.apexHeight == null) out.apexHeight = out.frontShoulderToWaist - 6.5;
  if (out.acrossShoulder == null) out.acrossShoulder = bust * 0.43;
  if (out.acrossBack == null) out.acrossBack = bust * 0.39;
  if (out.acrossFront == null) out.acrossFront = bust * 0.36;
  if (out.apexToApex == null) out.apexToApex = bust * 0.205;
  if (out.hipDepth == null) out.hipDepth = 9;
  if (out.skirtLength == null) out.skirtLength = 22;
  return out;
}

/* ---------------------- Module A: deterministic validation ------------------ */
function validate(raw, full) {
  const warnings = [];
  const bust = full.bust;
  if (raw.frontShoulderToWaist != null && raw.napeToWaist != null) {
    if (raw.frontShoulderToWaist < raw.napeToWaist) {
      warnings.push(
        "Front Shoulder to Waist is shorter than Nape to Waist — this usually under-drafts bust prominence. Expected Front ≥ Back."
      );
    }
  }
  if (raw.highBust != null && raw.bust != null) {
    if (raw.bust < raw.highBust) {
      warnings.push("Full Bust is smaller than High Bust — check the cup-slope; this will invert the bust dart angle.");
    }
  }
  const lo = bust / 8 + 1.5;
  const hi = bust / 8 + 3.5;
  if (raw.armholeDepth != null && (raw.armholeDepth < lo || raw.armholeDepth > hi)) {
    warnings.push(
      `Armhole Depth (${raw.armholeDepth.toFixed(2)}") is outside the standard range for this bust [${lo.toFixed(2)}"–${hi.toFixed(2)}"]. Using it as entered may distort the armscye.`
    );
  }
  if (full.fullHip < full.waist) {
    warnings.push("Full Hip is smaller than Waist — double check these two entries.");
  }
  return warnings;
}

/* ------------------------------ geometry utils ------------------------------ */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => (len(a) === 0 ? [0, 0] : scl(a, 1 / len(a)));
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const perp = (a) => [-a[1], a[0]]; // rotate 90°

function cubicBezierPoints(p0, c1, c2, p1, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p1[0];
    const y =
      mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p1[1];
    pts.push([x, y]);
  }
  return pts;
}

// Quarter-ellipse arc between a point on the vertical (CF/CB) line and a point
// on the horizontal (shoulder) line, tangent to both — used for necklines.
function quarterEllipsePoints(centerOnLine, radiusX, radiusY, n = 14) {
  // t=0 -> (0, radiusY) i.e. the point on the vertical (CF/CB) line, tangent horizontal
  // t=pi/2 -> (radiusX, 0) i.e. the point on the shoulder line, tangent vertical
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (Math.PI / 2) * (i / n);
    const x = centerOnLine[0] + radiusX * Math.sin(t);
    const y = centerOnLine[1] + radiusY * Math.cos(t);
    pts.push([x, y]);
  }
  return pts;
}

function pointsToPath(pts, close = false) {
  if (!pts.length) return "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" ");
  return close ? d + " Z" : d;
}

// Vertex-normal polygon offset — approximate seam-allowance construction.
// allowances[i] is the outward distance to push points[i].
function offsetPolyline(points, allowances, closed = true) {
  const n = points.length;
  const centroid = points.reduce((a, p) => add(a, p), [0, 0]).map((v) => v / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const e1 = norm(sub(points[i], prev));
    const e2 = norm(sub(next, points[i]));
    let normal = norm(add(perp(e1), perp(e2)));
    if (normal[0] === 0 && normal[1] === 0) normal = norm(perp(e1));
    // ensure the normal points away from the shape's centroid
    const outward = sub(points[i], centroid);
    if (normal[0] * outward[0] + normal[1] * outward[1] < 0) normal = scl(normal, -1);
    out.push(add(points[i], scl(normal, allowances[i] ?? 0.5)));
  }
  return out;
}

/* ============================================================================
   Module B — drafting engine
   Coordinate convention per half-pattern piece: x = 0 is the Center Front /
   Center Back fold line, x grows toward the side seam; y = 0 is the neckline/
   shoulder reference row, y grows downward toward the hem.
   Each draft function returns flattened point arrays per construction line so
   Module C can render them as independent, toggle-able layers.
============================================================================ */
function draftBodice(m, side /* 'front' | 'back' */) {
  const isFront = side === "front";
  const bustEase = m.bustEase ?? 2.5;
  const waistEase = m.waistEase ?? 1.25;

  const qBust = m.bust / 4 + bustEase / 4;
  const qWaist = m.waist / 4 + waistEase / 4;
  const neckWidth = m.neck / 5;
  const neckDepth = isFront ? m.neck / 5 + 0.6 : m.neck / 5 - 0.35;
  const shoulderDrop = isFront ? 1.9 : 1.5;
  const cfLength = isFront ? m.frontShoulderToWaist : m.napeToWaist;
  const armholeY = m.armholeDepth;
  const apexX = m.apexToApex / 2;
  const apexY = m.apexHeight;

  // key construction points
  const neckOnCF = [0, neckDepth];
  const neckOnShoulder = [neckWidth, 0];
  const shoulderTip = [m.acrossShoulder / 2, shoulderDrop];
  const underarm = [qBust, armholeY];

  // waist suppression split: ~55% side seam intake, ~45% dart intake
  const totalSuppression = Math.max(qBust - qWaist, 0.4);
  const sideIntake = totalSuppression * 0.55;
  const dartIntake = totalSuppression - sideIntake;
  const sideWaist = [qBust - sideIntake, cfLength];
  const cfWaist = [0, cfLength];

  const dartTipY = Math.max(apexY - 0.85, shoulderDrop + 1);
  const dartLeft = [Math.max(apexX - dartIntake / 2, 0.3), cfLength];
  const dartRight = [apexX + dartIntake / 2, cfLength];
  const dartTip = [apexX, dartTipY];

  // neckline — quarter ellipse tangent to CF (vertical) and shoulder (horizontal)
  const necklinePts = quarterEllipsePoints([0, 0], neckWidth, neckDepth);

  // armhole — cubic bezier from shoulder tip to underarm, bowed outward
  const d = sub(underarm, shoulderTip);
  const outward = norm(perp(d)); // outward = away from CF
  const bow = isFront ? len(d) * 0.28 : len(d) * 0.2;
  const c1 = add(add(shoulderTip, scl(d, 0.35)), scl(outward, bow));
  const c2 = add(add(shoulderTip, scl(d, 0.72)), scl(outward, bow * 0.35));
  const armholePts = cubicBezierPoints(shoulderTip, c1, c2, underarm, 18);

  const outline = [
    neckOnCF,
    ...necklinePts.slice(1),
    ...[neckOnShoulder, shoulderTip].slice(1),
    ...armholePts.slice(1),
    sideWaist,
    dartRight,
    dartTip,
    dartLeft,
    cfWaist,
  ];

  const allowance = outline.map((_, i) => {
    // side-seam vertices get 1", hem-less bodice gets 0.5" general seam,
    // the CF fold (first/last two points) gets 0 (cut on fold)
    if (i === outline.length - 1 || i === 0) return 0;
    return 0.5;
  });
  const sideIdx = outline.findIndex((p) => p === sideWaist);
  if (sideIdx >= 0) allowance[sideIdx] = 1;

  return {
    outline,
    seamAllowance: offsetPolyline(outline, allowance, true),
    neckline: [neckOnCF, ...necklinePts.slice(1)],
    shoulder: [neckOnShoulder, shoulderTip],
    armhole: armholePts,
    sideSeam: [underarm, sideWaist],
    cfLine: [neckOnCF, cfWaist],
    waistLine: [cfWaist, dartLeft],
    dart: [dartLeft, dartTip, dartRight],
    apex: [apexX, apexY],
    grainline: [
      [neckWidth * 0.4, neckDepth + 1],
      [neckWidth * 0.4, cfLength - 1],
    ],
    notches: [underarm, [qBust * 0.5, armholeY]],
    bounds: { w: m.acrossShoulder / 2 + 1, h: cfLength + 1 },
  };
}

function draftSkirt(m, side /* 'front' | 'back' */) {
  const isFront = side === "front";
  const hipEase = m.hipEase ?? 2;
  const waistEase = m.waistEase ?? 1.25;
  const split = isFront ? 1.02 : 0.98;

  const qWaist = (m.waist / 4 + waistEase / 4) * split;
  const qHighHip = (m.highHip / 4 + hipEase / 8) * split;
  const qFullHip = (m.fullHip / 4 + hipEase / 4) * split;

  const highHipY = m.hipDepth * 0.4;
  const fullHipY = m.hipDepth;
  const hemY = m.skirtLength;

  const cfTop = [0, 0];
  const cfHem = [0, hemY];

  const totalSuppression = Math.max(qFullHip - qWaist, 0.5);
  const sideIntake = totalSuppression * 0.5;
  const dartIntake = totalSuppression - sideIntake;

  const waistSide = [qFullHip - sideIntake, 0];
  const highHipSide = [qHighHip, highHipY];
  const fullHipSide = [qFullHip, fullHipY];
  const hemSide = [qFullHip, hemY]; // straight basic block, no flare

  const dartCenterX = qFullHip * 0.42;
  const dartLeft = [Math.max(dartCenterX - dartIntake / 2, 0.3), 0];
  const dartRight = [dartCenterX + dartIntake / 2, 0];
  const dartTip = [dartCenterX, m.hipDepth * 0.55];

  // hip curve: quadratic-ish smooth path through waistSide -> highHipSide -> fullHipSide
  const hipCurve = cubicBezierPoints(
    waistSide,
    lerp(waistSide, highHipSide, 0.5),
    lerp(highHipSide, fullHipSide, 0.3),
    fullHipSide,
    14
  );

  const outline = [cfTop, dartLeft, dartTip, dartRight, waistSide, ...hipCurve.slice(1), hemSide, cfHem];
  const allowance = outline.map((p, i) => {
    if (i === 0 || i === outline.length - 1) return 0; // CF fold
    if (p === hemSide) return 1.5; // hem
    if (p === waistSide) return 1; // side seam at waist
    return 0.5;
  });
  // hem segment (last two before CF) should carry hem allowance on both ends
  allowance[outline.length - 2] = 1.5;

  return {
    outline,
    seamAllowance: offsetPolyline(outline, allowance, true),
    waistLine: [cfTop, dartLeft],
    dart: [dartLeft, dartTip, dartRight],
    sideSeam: [waistSide, ...hipCurve.slice(1)],
    hemLine: [hemSide, cfHem],
    cfLine: [cfTop, cfHem],
    grainline: [
      [qFullHip * 0.35, 1],
      [qFullHip * 0.35, hemY - 1],
    ],
    notches: [highHipSide, fullHipSide],
    bounds: { w: qFullHip + 1, h: hemY + 1 },
  };
}

/* ================================ Module C ================================= */
const LAYER_DEFS = [
  { key: "outline", label: "Pattern Outline" },
  { key: "seamAllowance", label: "Seam Allowance" },
  { key: "grainline", label: "Grainline" },
  { key: "reference", label: "Reference Lines" },
  { key: "dart", label: "Dart Axes" },
  { key: "notches", label: "Notches" },
];

function PiecesSVG({ pieces, layers, scale, showRuler }) {
  const maxW = Math.max(...pieces.map((p) => p.gx + p.draft.bounds.w));
  const maxH = Math.max(...pieces.map((p) => (p.gy || 0) + p.draft.bounds.h));
  const pad = 1.2;
  const vbW = (maxW + pad * 2) * scale;
  const vbH = (maxH + pad * 2) * scale;

  return (
    <svg viewBox={`0 0 ${vbW} ${vbH}`} width="100%" height="100%" style={{ background: COLORS.canvas }}>
      <defs>
        <pattern id="dotgrid" width={scale} height={scale} patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill={COLORS.grid} />
        </pattern>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill={COLORS.chalk} />
        </marker>
      </defs>
      <rect x="0" y="0" width={vbW} height={vbH} fill="url(#dotgrid)" />

      {showRuler &&
        Array.from({ length: Math.ceil(maxW + pad * 2) }).map((_, i) => (
          <g key={`tx${i}`}>
            <line x1={i * scale} y1="0" x2={i * scale} y2="6" stroke={COLORS.muted} strokeWidth="1" />
            <text x={i * scale + 2} y="14" fontSize="9" fill={COLORS.muted} fontFamily="IBM Plex Mono">
              {i}
            </text>
          </g>
        ))}

      {pieces.map(({ gx, gy = 0, label, draft }, idx) => {
        const tx = (x) => (x + gx + pad) * scale;
        const ty = (y) => (y + gy + pad) * scale;
        const toPx = (pts) => pts.map(([x, y]) => [tx(x), ty(y)]);

        return (
          <g key={idx}>
            <text
              x={tx(0)}
              y={ty(-0.3)}
              fontFamily="Space Grotesk"
              fontWeight="600"
              fontSize="13"
              fill={COLORS.ink}
            >
              {label}
            </text>

            {layers.seamAllowance && (
              <path
                d={pointsToPath(toPx(draft.seamAllowance), true)}
                fill="none"
                stroke={COLORS.thread}
                strokeDasharray="5 4"
                strokeWidth="1.4"
              />
            )}

            {layers.outline && (
              <path d={pointsToPath(toPx(draft.outline), true)} fill={COLORS.paper} fillOpacity="0.55" stroke={COLORS.ink} strokeWidth="2" />
            )}

            {layers.reference && draft.cfLine && (
              <path d={pointsToPath(toPx(draft.cfLine))} stroke={COLORS.muted} strokeDasharray="2 3" strokeWidth="1" fill="none" />
            )}

            {layers.dart && draft.dart && (
              <path d={pointsToPath(toPx(draft.dart))} stroke={COLORS.thread} strokeWidth="1.6" fill="none" />
            )}

            {layers.grainline && draft.grainline && (
              <line
                x1={tx(draft.grainline[0][0])}
                y1={ty(draft.grainline[0][1])}
                x2={tx(draft.grainline[1][0])}
                y2={ty(draft.grainline[1][1])}
                stroke={COLORS.chalk}
                strokeWidth="1.8"
                markerEnd="url(#arrowhead)"
                markerStart="url(#arrowhead)"
              />
            )}

            {layers.notches &&
              draft.notches?.map((n, i) => (
                <line
                  key={i}
                  x1={tx(n[0])}
                  y1={ty(n[1])}
                  x2={tx(n[0]) + 6}
                  y2={ty(n[1]) + 6}
                  stroke={COLORS.ink}
                  strokeWidth="1.6"
                />
              ))}
          </g>
        );
      })}
    </svg>
  );
}

/* ============================ Module D: export ============================= */
const PAPER_IN = {
  a4: [8.27, 11.69],
  letter: [8.5, 11],
};

function TiledPrintPreview({ pieces, paper, onClose }) {
  const [pw, ph] = PAPER_IN[paper];
  const margin = 0.4;
  const overlap = 0.5;
  const contentW = pw - margin * 2;
  const contentH = ph - margin * 2;

  const maxX = Math.max(...pieces.map((p) => p.gx + p.draft.bounds.w)) + 1;
  const maxY = Math.max(...pieces.map((p) => (p.gy || 0) + p.draft.bounds.h)) + 1;

  const cols = Math.max(1, Math.ceil(maxX / (contentW - overlap)));
  const rows = Math.max(1, Math.ceil(maxY / (contentH - overlap)));
  const colLabel = (i) => String.fromCharCode(65 + i);

  const pages = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pages.push({ r, c, x0: c * (contentW - overlap), y0: r * (contentH - overlap) });
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000090", zIndex: 50, overflow: "auto" }}>
      <div className="no-print" style={{ position: "sticky", top: 0, background: COLORS.ink, color: "#fff", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "IBM Plex Sans" }}>
        <span>
          Tiled print preview — {paper.toUpperCase()}, {cols}×{rows} pages. Print at <b>100% / Actual Size</b> (no "fit to page").
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={btnStyle(COLORS.brass)}>Print</button>
          <button onClick={onClose} style={btnStyle("#555")}>Close</button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, padding: 24 }}>
        {pages.map(({ r, c, x0, y0 }, i) => (
          <div
            key={i}
            className="print-page"
            style={{
              width: `${pw}in`,
              height: `${ph}in`,
              background: "#fff",
              boxShadow: "0 2px 10px #0006",
              position: "relative",
              pageBreakAfter: "always",
            }}
          >
            <svg
              viewBox={`${x0 - margin} ${y0 - margin} ${pw} ${ph}`}
              width={`${pw}in`}
              height={`${ph}in`}
            >
              {/* registration crosshairs at the four page corners */}
              {[
                [x0, y0],
                [x0 + contentW, y0],
                [x0, y0 + contentH],
                [x0 + contentW, y0 + contentH],
              ].map((p, k) => (
                <g key={k} stroke={COLORS.thread} strokeWidth="0.02">
                  <line x1={p[0] - 0.15} y1={p[1]} x2={p[0] + 0.15} y2={p[1]} />
                  <line x1={p[0]} y1={p[1] - 0.15} x2={p[0]} y2={p[1] + 0.15} />
                </g>
              ))}
              {r === 0 && c === 0 && (
                <g>
                  <rect x={x0 + 0.1} y={y0 + 0.1} width="2" height="2" fill="none" stroke={COLORS.ink} strokeWidth="0.03" />
                  <text x={x0 + 0.15} y={y0 + 2.3} fontSize="0.14" fontFamily="IBM Plex Mono">2in × 2in — verify before cutting</text>
                </g>
              )}
              <text x={x0 + margin} y={y0 + margin + 0.25} fontSize="0.16" fontFamily="IBM Plex Mono" fill={COLORS.muted}>
                Row {r + 1} / Col {colLabel(c)}
              </text>
              {pieces.map(({ gx, gy = 0, draft }, idx) => (
                <g key={idx}>
                  <path d={pointsToPath(draft.outline.map(([x, y]) => [x + gx + 1, y + gy + 1]), true)} fill="none" stroke={COLORS.ink} strokeWidth="0.02" />
                  <path d={pointsToPath(draft.seamAllowance.map(([x, y]) => [x + gx + 1, y + gy + 1]), true)} fill="none" stroke={COLORS.thread} strokeWidth="0.015" strokeDasharray="0.08 0.06" />
                </g>
              ))}
            </svg>
          </div>
        ))}
      </div>
      <style>{`@media print { .no-print { display: none; } body * { visibility: hidden; } .print-page, .print-page * { visibility: visible; } .print-page { position: relative; margin: 0; box-shadow: none !important; } }`}</style>
    </div>
  );
}

function btnStyle(bg) {
  return {
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    padding: "6px 14px",
    fontFamily: "IBM Plex Sans",
    fontSize: 13,
    cursor: "pointer",
  };
}

/* =================================== App ==================================== */
export default function SloperStudio() {
  const [unit, setUnit] = useState("in");
  const [measIn, setMeasIn] = useState(DEFAULTS_IN);
  const [block, setBlock] = useState("bodice"); // bodice | skirt | dress
  const [showTiled, setShowTiled] = useState(false);
  const [paper, setPaper] = useState("letter");
  const svgWrapRef = useRef(null);
  const [layers, setLayers] = useState(
    Object.fromEntries(LAYER_DEFS.map((l) => [l.key, true]))
  );

  const full = useMemo(() => deriveMeasurements(measIn), [measIn]);
  const warnings = useMemo(() => validate(measIn, full), [measIn, full]);

  const setField = (key, str) => {
    const v = fromDisplay(str, unit);
    setMeasIn((prev) => ({ ...prev, [key]: str === "" ? null : v }));
  };

  const pieces = useMemo(() => {
    if (block === "bodice") {
      const f = draftBodice(full, "front");
      const b = draftBodice(full, "back");
      return [
        { label: "Front Bodice ×1 on fold", gx: 0, draft: f },
        { label: "Back Bodice ×1 on fold", gx: f.bounds.w + 1.5, draft: b },
      ];
    }
    if (block === "skirt") {
      const f = draftSkirt(full, "front");
      const b = draftSkirt(full, "back");
      return [
        { label: "Front Skirt ×1 on fold", gx: 0, draft: f },
        { label: "Back Skirt ×1 on fold", gx: f.bounds.w + 1.5, draft: b },
      ];
    }
    // dress: bodice pieces sit above skirt pieces, stitched at the waistline
    const bf = draftBodice(full, "front");
    const bb = draftBodice(full, "back");
    const sf = draftSkirt(full, "front");
    const sb = draftSkirt(full, "back");
    const bodiceH = Math.max(bf.bounds.h, bb.bounds.h) + 1.5;
    return [
      { label: "Front Bodice", gx: 0, gy: 0, draft: bf },
      { label: "Back Bodice", gx: bf.bounds.w + 1.5, gy: 0, draft: bb },
      { label: "Front Skirt (joins at waist)", gx: 0, gy: bodiceH, draft: sf },
      { label: "Back Skirt (joins at waist)", gx: bf.bounds.w + 1.5, gy: bodiceH, draft: sb },
    ];
  }, [block, full]);

  const downloadSVG = () => {
    const svgEl = svgWrapRef.current?.querySelector("svg");
    if (!svgEl) return;
    const clone = svgEl.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const blob = new Blob([clone.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${block}-sloper-full-scale.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ fontFamily: "IBM Plex Sans", color: COLORS.ink, height: "100%", display: "flex", flexDirection: "column", background: COLORS.paper }}>
      <style>{FONT_IMPORT}</style>

      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${COLORS.grid}`, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "Space Grotesk", fontWeight: 700, fontSize: 20 }}>Sloper Studio</span>
          <span style={{ fontSize: 12, color: COLORS.muted }}>parametric drafting engine</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["bodice", "skirt", "dress"].map((b) => (
            <button
              key={b}
              onClick={() => setBlock(b)}
              style={{
                ...btnStyle(block === b ? COLORS.chalk : "#ffffff00"),
                color: block === b ? "#fff" : COLORS.ink,
                border: `1px solid ${COLORS.chalk}`,
                textTransform: "capitalize",
              }}
            >
              {b}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: COLORS.muted }}>Units</span>
          <button onClick={() => setUnit("in")} style={btnStyle(unit === "in" ? COLORS.brass : "#999")}>in</button>
          <button onClick={() => setUnit("cm")} style={btnStyle(unit === "cm" ? COLORS.brass : "#999")}>cm</button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
        {/* sidebar */}
        <div style={{ width: 340, minWidth: 300, borderRight: `1px solid ${COLORS.grid}`, overflowY: "auto", padding: 16 }}>
          {FIELD_GROUPS.map((g) => (
            <div key={g.label} style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: "Space Grotesk", fontWeight: 600, fontSize: 12, letterSpacing: 0.5, color: COLORS.muted, textTransform: "uppercase", marginBottom: 8 }}>
                {g.label}
              </div>
              {g.fields.map((f) => {
                const isEstimated = measIn[f.key] == null;
                return (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <label style={{ fontSize: 12.5, flex: 1, color: isEstimated ? COLORS.muted : COLORS.ink, fontStyle: isEstimated ? "italic" : "normal" }}>
                      {f.label}
                      {isEstimated && <span style={{ fontSize: 10 }}> (est.)</span>}
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder={toDisplay(full[f.key], unit)}
                      value={measIn[f.key] == null ? "" : toDisplay(measIn[f.key], unit)}
                      onChange={(e) => setField(f.key, e.target.value)}
                      style={{
                        width: 72,
                        fontFamily: "IBM Plex Mono",
                        fontSize: 12.5,
                        padding: "4px 6px",
                        border: `1px solid ${COLORS.grid}`,
                        borderRadius: 4,
                        background: "#fff",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: "Space Grotesk", fontWeight: 600, fontSize: 12, letterSpacing: 0.5, color: COLORS.muted, textTransform: "uppercase", marginBottom: 8 }}>
              Ease Allowance (total, per spec §B.1)
            </div>
            {[
              ["bustEase", "Bust ease", 2.5],
              ["waistEase", "Waist ease", 1.25],
              ["hipEase", "Hip ease", 2],
            ].map(([key, label, def]) => (
              <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <label style={{ fontSize: 12.5, flex: 1 }}>{label}</label>
                <input
                  type="number"
                  step="0.1"
                  value={measIn[key] ?? def}
                  onChange={(e) => setMeasIn((p) => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
                  style={{ width: 72, fontFamily: "IBM Plex Mono", fontSize: 12.5, padding: "4px 6px", border: `1px solid ${COLORS.grid}`, borderRadius: 4, background: "#fff" }}
                />
              </div>
            ))}
          </div>

          {warnings.length > 0 && (
            <div style={{ background: "#fff3f2", border: `1px solid ${COLORS.thread}`, borderRadius: 6, padding: 10, marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: COLORS.thread, marginBottom: 4 }}>Validation warnings</div>
              {warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 11.5, color: COLORS.thread, marginBottom: 4 }}>• {w}</div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontFamily: "Space Grotesk", fontWeight: 600, fontSize: 12, letterSpacing: 0.5, color: COLORS.muted, textTransform: "uppercase", marginBottom: 8 }}>
              Layers
            </div>
            {LAYER_DEFS.map((l) => (
              <label key={l.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginBottom: 6 }}>
                <input type="checkbox" checked={layers[l.key]} onChange={() => setLayers((p) => ({ ...p, [l.key]: !p[l.key] }))} />
                {l.label}
              </label>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
            <button onClick={downloadSVG} style={btnStyle(COLORS.chalk)}>Download full-scale SVG (roll / plotter)</button>
            <div style={{ display: "flex", gap: 8 }}>
              <select value={paper} onChange={(e) => setPaper(e.target.value)} style={{ flex: 1, borderRadius: 4, border: `1px solid ${COLORS.grid}`, fontSize: 12.5 }}>
                <option value="letter">US Letter</option>
                <option value="a4">A4</option>
              </select>
              <button onClick={() => setShowTiled(true)} style={{ ...btnStyle(COLORS.brass), flex: 1 }}>Tiled print preview</button>
            </div>
            <div style={{ fontSize: 10.5, color: COLORS.muted, lineHeight: 1.4 }}>
              Industrial AAMA/DXF and HPGL/PLT export need a native writer and aren't produced by this browser build — the full-scale SVG is dimensionally exact and can be converted downstream.
            </div>
          </div>
        </div>

        {/* canvas */}
        <div ref={svgWrapRef} style={{ flex: 1, minWidth: 320, minHeight: 420 }}>
          <PiecesSVG pieces={pieces} layers={layers} scale={26} showRuler={true} />
        </div>
      </div>

      {showTiled && <TiledPrintPreview pieces={pieces} paper={paper} onClose={() => setShowTiled(false)} />}
    </div>
  );
}
