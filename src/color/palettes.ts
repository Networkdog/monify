// Well-known, perceptually-designed color palettes, stored as hex control
// stops. Sequential and diverging palettes are interpolated by the scale
// functions in ./scales; categorical palettes are indexed directly.
//
// Sources:
//   - Sequential (viridis, inferno, magma, plasma, cividis): matplotlib.
//     Perceptually uniform; cividis is optimized for color-vision deficiency.
//   - Diverging (rdbu, piyg, brbg): ColorBrewer. Meaningful midpoint.
//   - Categorical (tableau10, set2): Tableau 10 and ColorBrewer Set2.
//     Chosen for maximal perceptual separation; set2 is colorblind-friendly.

export type SequentialName = 'viridis' | 'inferno' | 'magma' | 'plasma' | 'cividis';
export type DivergingName = 'rdbu' | 'piyg' | 'brbg' | 'rdylgn';
export type CategoricalName = 'tableau10' | 'set2';
export type PaletteName = SequentialName | DivergingName | CategoricalName;

/** Sequential palettes — ordered from low (0) to high (1). */
export const SEQUENTIAL: Record<SequentialName, readonly string[]> = {
  viridis: [
    '#440154', '#482878', '#3e4a89', '#31688e', '#26828e',
    '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725',
  ],
  inferno: [
    '#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60',
    '#cf4446', '#ed6925', '#fb9a06', '#f7d13d', '#fcffa4',
  ],
  magma: [
    '#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f',
    '#cd4071', '#f1605d', '#fd9567', '#feca8d', '#fcfdbf',
  ],
  plasma: [
    '#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786',
    '#d8576b', '#ed7953', '#fa9e3b', '#fdc926', '#f0f921',
  ],
  cividis: [
    '#00224e', '#123570', '#3b496c', '#575d6d', '#707173',
    '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838',
  ],
};

/** Diverging palettes — low extreme, neutral midpoint, high extreme. */
export const DIVERGING: Record<DivergingName, readonly string[]> = {
  rdbu: [
    '#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7',
    '#f7f7f7',
    '#d1e5f0', '#92c5de', '#4393c3', '#2166ac', '#053061',
  ],
  piyg: [
    '#8e0152', '#c51b7d', '#de77ae', '#f1b6da', '#fde0ef',
    '#f7f7f7',
    '#e6f5d0', '#b8e186', '#7fbc41', '#4d9221', '#276419',
  ],
  brbg: [
    '#543005', '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3',
    '#f5f5f5',
    '#c7eae5', '#80cdc1', '#35978f', '#01665e', '#003c30',
  ],
  // Red→Yellow→Green status ramp (ColorBrewer RdYlGn). Ordered low→high
  // as red→green; sample with (1 - severity) so healthy reads green.
  rdylgn: [
    '#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b',
    '#ffffbf',
    '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837',
  ],
};

/** Categorical palettes — indexed by category (wraps modulo length). */
export const CATEGORICAL: Record<CategoricalName, readonly string[]> = {
  tableau10: [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  ],
  set2: [
    '#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3',
    '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3',
  ],
};

export const SEQUENTIAL_NAMES = Object.keys(SEQUENTIAL) as SequentialName[];
export const DIVERGING_NAMES = Object.keys(DIVERGING) as DivergingName[];
export const CATEGORICAL_NAMES = Object.keys(CATEGORICAL) as CategoricalName[];

/** True if `name` is a sequential palette. */
export function isSequential(name: string): name is SequentialName {
  return name in SEQUENTIAL;
}
/** True if `name` is a diverging palette. */
export function isDiverging(name: string): name is DivergingName {
  return name in DIVERGING;
}
/** True if `name` is a categorical palette. */
export function isCategorical(name: string): name is CategoricalName {
  return name in CATEGORICAL;
}
