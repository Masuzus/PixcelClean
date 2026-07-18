import type { PixelPosition } from "./protectionMask";

export type ProjectMemoryPreviewMode = "remove-background" | "remove-foreground" | "mask";
export type ProjectMemoryPreviewBackgroundMode = "checkerboard" | "black" | "white" | "custom";
export type ProjectMemoryInteractionMode = "pan" | "protect" | "erase";

export type ProjectMemory = {
  imageKey: string;
  distanceMetricVersion: string;
  localColorAlgorithmVersion: string;
  localColorThreshold: number;
  edgeGlowWidth?: number;
  width: number;
  height: number;
  protectedMask: Uint8Array;
  selectedThreshold: number;
  brushSize: number;
  previewMode: ProjectMemoryPreviewMode;
  previewBackgroundMode?: ProjectMemoryPreviewBackgroundMode;
  customPreviewBackgroundColor?: string;
  interactionMode: ProjectMemoryInteractionMode;
  imageView: {
    zoom: number;
    offsetX: number;
    offsetY: number;
  };
  selectedPixel: PixelPosition | null;
};

const databaseName = "pixel-clean-project-memory";
const databaseVersion = 1;
const storeName = "projects";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前运行环境不支持项目记忆存储。"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "imageKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开项目记忆存储。"));
  });
}

export async function createImageMemoryKey(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前运行环境不支持图片指纹计算。");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function loadProjectMemory(imageKey: string): Promise<ProjectMemory | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(imageKey);
      request.onsuccess = () => {
        const memory = request.result;
        if (!memory) {
          resolve(null);
          return;
        }
        resolve({
          ...memory,
          previewMode: normalizeProjectMemoryPreviewMode(memory.previewMode),
          previewBackgroundMode: normalizeProjectMemoryPreviewBackgroundMode(memory.previewBackgroundMode),
          customPreviewBackgroundColor: normalizeProjectMemoryPreviewBackgroundColor(memory.customPreviewBackgroundColor),
        });
      };
      request.onerror = () => reject(request.error ?? new Error("无法读取项目记忆。"));
    });
  } finally {
    database.close();
  }
}

export function normalizeProjectMemoryPreviewMode(value: unknown): ProjectMemoryPreviewMode {
  if (value === "remove-foreground" || value === "mask") return value;
  return "remove-background";
}

export function normalizeProjectMemoryPreviewBackgroundMode(value: unknown): ProjectMemoryPreviewBackgroundMode {
  if (value === "black" || value === "white" || value === "custom") return value;
  return "checkerboard";
}

export function normalizeProjectMemoryPreviewBackgroundColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : "#6B7280";
}

export async function saveProjectMemory(memory: ProjectMemory): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put({
        ...memory,
        protectedMask: new Uint8Array(memory.protectedMask),
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("无法保存项目记忆。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("项目记忆保存已取消。"));
    });
  } finally {
    database.close();
  }
}
