import type { OklabColor } from "./colorSpace.ts";

export const backgroundDistanceMetricVersion = "directional-oklch-v1";

export type DirectionalBackgroundDistanceProfile = {
  lightnessWeight: number;
  chromaWeight: number;
  hueWeight: number;
};

export type DirectionalBackgroundDistance = {
  deltaLightness: number;
  deltaChroma: number;
  deltaHue: number;
  distance: number;
};

export const defaultBackgroundDistanceProfile: Readonly<DirectionalBackgroundDistanceProfile> = {
  lightnessWeight: 0.5,
  chromaWeight: 2,
  hueWeight: 2,
};

function normalizeHueDelta(delta: number): number {
  let normalized = delta;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function validateProfile(profile: DirectionalBackgroundDistanceProfile): void {
  if (
    !Number.isFinite(profile.lightnessWeight)
    || !Number.isFinite(profile.chromaWeight)
    || !Number.isFinite(profile.hueWeight)
    || profile.lightnessWeight <= 0
    || profile.chromaWeight <= 0
    || profile.hueWeight <= 0
  ) {
    throw new Error("Directional background distance weights must be finite and greater than zero.");
  }
}

export function getDirectionalBackgroundDistance(
  pixelLab: OklabColor,
  backgroundLab: OklabColor,
  profile: DirectionalBackgroundDistanceProfile = defaultBackgroundDistanceProfile,
): DirectionalBackgroundDistance {
  validateProfile(profile);
  const pixelChroma = Math.hypot(pixelLab[1], pixelLab[2]);
  const backgroundChroma = Math.hypot(backgroundLab[1], backgroundLab[2]);
  const pixelHue = Math.atan2(pixelLab[2], pixelLab[1]);
  const backgroundHue = Math.atan2(backgroundLab[2], backgroundLab[1]);
  const deltaLightness = pixelLab[0] - backgroundLab[0];
  const deltaChroma = pixelChroma - backgroundChroma;
  const deltaHue = 2
    * Math.sqrt(pixelChroma * backgroundChroma)
    * Math.sin(normalizeHueDelta(pixelHue - backgroundHue) / 2);
  const distance = Math.hypot(
    profile.lightnessWeight * deltaLightness,
    profile.chromaWeight * deltaChroma,
    profile.hueWeight * deltaHue,
  );
  return { deltaLightness, deltaChroma, deltaHue, distance };
}

export function directionalBackgroundDistance(
  pixelLab: OklabColor,
  backgroundLab: OklabColor,
  profile: DirectionalBackgroundDistanceProfile = defaultBackgroundDistanceProfile,
): number {
  return getDirectionalBackgroundDistance(pixelLab, backgroundLab, profile).distance;
}
