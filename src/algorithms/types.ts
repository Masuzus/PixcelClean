export type ColorEntry = {
  hex: string;
  cssColor: string;
  alpha: number;
  lightness: number;
  hue: number;
  count: number;
};

export type RgbColor = [number, number, number];

export type RgbaImageView = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
};

export type PaletteReductionSettings = {
  enabled: boolean;
  maximumColors: number;
};

export type EdgeMode = "natural" | "hard";

export type ImageProcessingOptions = {
  includeEnclosedAreas: boolean;
  protectedMask: Uint8Array | null;
  backgroundColor: RgbColor;
  edgeMode?: EdgeMode;
  paletteReduction: PaletteReductionSettings;
};

export type ImageProcessingStats = {
  removedBackgroundPixels: number;
  originalColorCount: number;
  reducedColorCount: number;
  replacedColorPixels: number;
  decontaminatedEdgePixels: number;
  semiTransparentPixels: number;
};

export type ImageProcessingResult = {
  image: ImageData;
  stats: ImageProcessingStats;
};
