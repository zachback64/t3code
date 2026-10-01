// Per-project accent colors for the legacy sidebar.
//
// Every project gets a color from a fixed palette. Colors are auto-assigned
// the first time a project shows up (least-used color first, so the first
// dozen projects never share one) and remembered, so a project keeps its color
// when projects are added, removed or reordered. A color picked from the
// project context menu overrides the automatic one; "Automatic" drops the
// override. Both maps live in the UI state store next to the other sidebar
// layout prefs (no settings schema or DB migration).

export interface ProjectColor {
  readonly id: string;
  readonly name: string;
  // Tailwind 600 (700 for lime) in light mode and 400 in dark mode: both clear 3:1 against
  // the sidebar background, which is what a non-text accent needs.
  readonly light: string;
  readonly dark: string;
}

export const PROJECT_COLORS: readonly ProjectColor[] = [
  { id: "blue", name: "Blue", light: "#2563eb", dark: "#60a5fa" },
  { id: "orange", name: "Orange", light: "#ea580c", dark: "#fb923c" },
  { id: "green", name: "Green", light: "#059669", dark: "#34d399" },
  { id: "pink", name: "Pink", light: "#db2777", dark: "#f472b6" },
  { id: "violet", name: "Violet", light: "#7c3aed", dark: "#a78bfa" },
  { id: "amber", name: "Amber", light: "#d97706", dark: "#fbbf24" },
  { id: "teal", name: "Teal", light: "#0d9488", dark: "#2dd4bf" },
  { id: "red", name: "Red", light: "#dc2626", dark: "#f87171" },
  { id: "sky", name: "Sky", light: "#0284c7", dark: "#38bdf8" },
  { id: "lime", name: "Lime", light: "#4d7c0f", dark: "#a3e635" },
  { id: "fuchsia", name: "Fuchsia", light: "#c026d3", dark: "#e879f9" },
  { id: "slate", name: "Slate", light: "#475569", dark: "#94a3b8" },
];

const PROJECT_COLOR_BY_ID = new Map(PROJECT_COLORS.map((color) => [color.id, color] as const));

export function getProjectColor(colorId: string | null | undefined): ProjectColor | null {
  return colorId ? (PROJECT_COLOR_BY_ID.get(colorId) ?? null) : null;
}

export function isProjectColorId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_COLOR_BY_ID.has(value);
}

export interface ProjectColorState {
  // Project preference key -> color id picked by the user.
  readonly projectColorById: Readonly<Record<string, string>>;
  // Project preference key -> color id assigned automatically.
  readonly projectAutoColorById: Readonly<Record<string, string>>;
}

/** Keeps only entries with a non-empty key and a known color id. */
export function sanitizeProjectColorRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[0].length > 0 && isProjectColorId(entry[1]),
    ),
  );
}

function firstMatch(
  record: Readonly<Record<string, string>>,
  preferenceKeys: readonly string[],
): string | null {
  for (const key of preferenceKeys) {
    const colorId = record[key];
    if (colorId !== undefined && PROJECT_COLOR_BY_ID.has(colorId)) {
      return colorId;
    }
  }
  return null;
}

/** The user's pick for a project, or null when it follows the automatic color. */
export function resolveProjectColorOverride(
  state: ProjectColorState,
  preferenceKeys: readonly string[],
): string | null {
  return firstMatch(state.projectColorById, preferenceKeys);
}

/** The color a project row renders with: user pick, else auto color, else a hash fallback. */
export function resolveProjectColor(
  state: ProjectColorState,
  preferenceKeys: readonly string[],
): ProjectColor {
  const colorId =
    firstMatch(state.projectColorById, preferenceKeys) ??
    firstMatch(state.projectAutoColorById, preferenceKeys);
  return getProjectColor(colorId) ?? PROJECT_COLORS[hashProjectKey(preferenceKeys[0] ?? "")]!;
}

/** Stable palette index for a key (FNV-1a), used as a tiebreak and as a fallback. */
export function hashProjectKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PROJECT_COLORS.length;
}

/**
 * Gives every project that has neither a pick nor an auto color the palette
 * color currently used by the fewest projects. Ties go to the color closest
 * (forward, wrapping) to the project's hash slot, so the result is
 * deterministic. Existing assignments never change. Each project is given as
 * its preference keys, primary key first; new colors are stored under the
 * primary key.
 */
export function assignAutoProjectColors<S extends ProjectColorState>(
  state: S,
  projects: readonly (readonly string[])[],
): S {
  const usage = new Map<string, number>(PROJECT_COLORS.map((color) => [color.id, 0] as const));
  const pending: string[] = [];
  for (const preferenceKeys of projects) {
    const primaryKey = preferenceKeys[0];
    if (!primaryKey) continue;
    const colorId =
      firstMatch(state.projectColorById, preferenceKeys) ??
      firstMatch(state.projectAutoColorById, preferenceKeys);
    if (colorId === null) {
      pending.push(primaryKey);
    } else {
      usage.set(colorId, (usage.get(colorId) ?? 0) + 1);
    }
  }
  if (pending.length === 0) {
    return state;
  }

  const projectAutoColorById = { ...state.projectAutoColorById };
  for (const key of [...new Set(pending)].toSorted()) {
    const minUsage = Math.min(...usage.values());
    const start = hashProjectKey(key);
    let chosen = PROJECT_COLORS[start]!;
    for (let offset = 0; offset < PROJECT_COLORS.length; offset++) {
      const candidate = PROJECT_COLORS[(start + offset) % PROJECT_COLORS.length]!;
      if (usage.get(candidate.id) === minUsage) {
        chosen = candidate;
        break;
      }
    }
    projectAutoColorById[key] = chosen.id;
    usage.set(chosen.id, (usage.get(chosen.id) ?? 0) + 1);
  }
  return { ...state, projectAutoColorById };
}

/**
 * Sets (or with null, clears) a project's color pick. Stale picks under the
 * project's other keys are dropped so the project resolves to one color.
 */
export function setProjectColor<S extends ProjectColorState>(
  state: S,
  preferenceKeys: readonly string[],
  colorId: string | null,
): S {
  const [primaryKey, ...otherKeys] = preferenceKeys;
  if (!primaryKey || (colorId !== null && !PROJECT_COLOR_BY_ID.has(colorId))) {
    return state;
  }
  const projectColorById = { ...state.projectColorById };
  let changed = false;
  for (const key of otherKeys) {
    if (key !== primaryKey && key in projectColorById) {
      delete projectColorById[key];
      changed = true;
    }
  }
  if (colorId === null) {
    if (primaryKey in projectColorById) {
      delete projectColorById[primaryKey];
      changed = true;
    }
  } else if (projectColorById[primaryKey] !== colorId) {
    projectColorById[primaryKey] = colorId;
    changed = true;
  }
  return changed ? { ...state, projectColorById } : state;
}

/**
 * CSS custom properties for a project row and its threads. `--project-accent`
 * switches with the theme in CSS (see the `.project-accent` rule in index.css).
 */
export function projectColorStyle(color: ProjectColor): Record<string, string> {
  return {
    "--project-accent-light": color.light,
    "--project-accent-dark": color.dark,
  };
}
