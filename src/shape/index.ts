// monify shape toolkit — analyze user data and turn it into cell + layer data.
//
//   defineDataset({ data, id, hierarchy, measures, dimensions })
//     .toHexGrid({ layout, color, label, tooltip })
//
// Everything here is pure and deterministic: the same rows always compile to
// the same cells, so a view is stable across reloads.

export { defineDataset, Dataset, type DatasetOptions } from './dataset';
export type {
  Accessor,
  AggName,
  DatasetSpec,
  DimensionSpec,
  Issue,
  LegendEntry,
  MeasureSpec,
  PaletteRef,
} from './types';
export {
  buildHierarchy,
  inspectHierarchy,
  nodesAtDepth,
  normalizeKey,
  pathKey,
  pathOf,
  MISSING_KEY,
  type HierarchyNode,
} from './hierarchy';
export { aggregate, describe, rollupTree, type MeasureStats } from './aggregate';
export {
  buildCategoryScale,
  categoryColor,
  isCategoricalColor,
  mapRange,
  quantitativeScale,
  NEUTRAL_TINT,
  type CategoricalColor,
  type CategoryOrderOptions,
  type CategoryScale,
  type CentralEncoding,
  type ColorEncoding,
  type EncodingSpec,
  type QuantitativeColor,
  type RangeEncoding,
  type ResourceValue,
  type TooltipEncoding,
} from './encode';
export {
  compileLayers,
  layerAtZoom,
  type CompiledLayer,
  type CompileLayersOptions,
  type LayerGroup,
  type LayerSpec,
} from './layers';
export {
  compileRows,
  rowsToHexGrid,
  treeToTreeMap,
  type CompiledRow,
  type HexGridInput,
  type ToHexGridOptions,
  type ToTreeMapOptions,
} from './compile';
export {
  profileRows,
  type DataProfile,
  type FieldKind,
  type FieldProfile,
  type HierarchyCandidate,
  type Recommendation,
} from './profile';
export { formatReport, validateSpec, type ValidationReport } from './validate';
