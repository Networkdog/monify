// Color module barrel — palettes and scale functions.
export {
  SEQUENTIAL,
  DIVERGING,
  CATEGORICAL,
  SEQUENTIAL_NAMES,
  DIVERGING_NAMES,
  CATEGORICAL_NAMES,
  isSequential,
  isDiverging,
  isCategorical,
  type SequentialName,
  type DivergingName,
  type CategoricalName,
  type PaletteName,
} from './palettes';
export {
  hexToRgba,
  interpolateRgb,
  resolveColor,
  sampleStops,
  sequential,
  diverging,
  categorical,
  paletteStops,
  type ColorInput,
  type ColorScale,
} from './scales';
