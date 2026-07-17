import type { RgbColor } from "./types";

export type OklabColor = [number, number, number];

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(red: number, green: number, blue: number): OklabColor {
  const linearRed = srgbToLinear(red / 255);
  const linearGreen = srgbToLinear(green / 255);
  const linearBlue = srgbToLinear(blue / 255);
  const light = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
  const medium = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
  const short = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
  return [
    0.2104542553 * light + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * light - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * light + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

export function colorDistanceSquared(left: OklabColor, right: OklabColor): number {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

export function getHueDegrees(color: OklabColor): number {
  const degrees = Math.atan2(color[2], color[1]) * 180 / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

export function getHueFamily(color: OklabColor): number {
  const chroma = Math.hypot(color[1], color[2]);
  if (chroma < 0.02) return 0;
  const hue = getHueDegrees(color);
  if (hue >= 345 || hue < 45) return 1;
  if (hue < 120) return 2;
  if (hue < 180) return 3;
  if (hue < 230) return 4;
  if (hue < 290) return 5;
  return 6;
}

export function colorToHex(color: RgbColor): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
