import { useSyncExternalStore } from 'react';
import { DEFAULT_LAYOUT, type LayoutSettings } from './lib/layout';
import type { Sensitivity } from './lib/peaks';

export interface Settings {
  sensitivity: Sensitivity;
  /** Seconds before / after the chat peak. */
  before: number;
  after: number;
  horizontal: boolean;
  vertical: boolean;
  quality: 720 | 1080;
  subtitles: boolean;
  language: string;
  layout: LayoutSettings;
  /** Live: render automatically when a moment is found. */
  autoRender: boolean;
  /** Live: minutes kept in memory. */
  bufferMinutes: number;
  /** VOD: how many moments to propose. */
  maxMoments: number;
}

export const DEFAULTS: Settings = {
  sensitivity: 'medium',
  before: 25,
  after: 8,
  horizontal: true,
  vertical: true,
  quality: 720,
  subtitles: true,
  language: 'auto',
  layout: DEFAULT_LAYOUT,
  autoRender: true,
  bufferMinutes: 3,
  maxMoments: 12,
};

const KEY = 'justclip-settings';

function read(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULTS, ...saved, layout: { ...DEFAULTS.layout, ...saved.layout } };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getSettings() {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage blocked */
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Layout remembered per channel (facecams don't move between streams). */
export function layoutFor(channel: string): LayoutSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(`justclip-layout:${channel.toLowerCase()}`) ?? 'null');
    if (saved) return { ...current.layout, ...saved };
  } catch {
    /* ignore */
  }
  return current.layout;
}

export function saveLayout(channel: string, layout: LayoutSettings) {
  updateSettings({ layout });
  try {
    localStorage.setItem(`justclip-layout:${channel.toLowerCase()}`, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}
