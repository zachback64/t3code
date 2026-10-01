import { describe, expect, it } from "vite-plus/test";

import {
  assignAutoProjectColors,
  hashProjectKey,
  PROJECT_COLORS,
  type ProjectColorState,
  resolveProjectColor,
  resolveProjectColorOverride,
  sanitizeProjectColorRecord,
  setProjectColor,
} from "./projectColors";

function state(
  projectColorById: Record<string, string> = {},
  projectAutoColorById: Record<string, string> = {},
): ProjectColorState {
  return { projectColorById, projectAutoColorById };
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].toSorted((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("project color palette", () => {
  it("has unique ids and names", () => {
    expect(new Set(PROJECT_COLORS.map((color) => color.id)).size).toBe(PROJECT_COLORS.length);
    expect(new Set(PROJECT_COLORS.map((color) => color.name)).size).toBe(PROJECT_COLORS.length);
  });

  it("keeps every accent at 3:1 or better against light and dark sidebars", () => {
    for (const color of PROJECT_COLORS) {
      expect(contrast(color.light, "#fafafa"), color.id).toBeGreaterThanOrEqual(3);
      expect(contrast(color.dark, "#18181b"), color.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("automatic project colors", () => {
  it("gives the first projects distinct colors", () => {
    const projects = PROJECT_COLORS.map((_, index) => [`project-${index}`]);
    const next = assignAutoProjectColors(state(), projects);
    const assigned = Object.values(next.projectAutoColorById);
    expect(assigned).toHaveLength(PROJECT_COLORS.length);
    expect(new Set(assigned).size).toBe(PROJECT_COLORS.length);
  });

  it("never changes a color once assigned", () => {
    const first = assignAutoProjectColors(state(), [["alpha"], ["beta"]]);
    const second = assignAutoProjectColors(first, [["aardvark"], ["alpha"], ["beta"], ["zulu"]]);
    expect(second.projectAutoColorById.alpha).toBe(first.projectAutoColorById.alpha);
    expect(second.projectAutoColorById.beta).toBe(first.projectAutoColorById.beta);
    expect(new Set(Object.values(second.projectAutoColorById)).size).toBe(4);
  });

  it("avoids colors the user already picked for other projects", () => {
    const picked = state({ alpha: PROJECT_COLORS[hashProjectKey("beta")]!.id });
    const next = assignAutoProjectColors(picked, [["alpha"], ["beta"]]);
    expect(next.projectAutoColorById.alpha).toBeUndefined();
    expect(next.projectAutoColorById.beta).not.toBe(picked.projectColorById.alpha);
  });

  it("is deterministic and returns the same state when nothing is new", () => {
    const projects = [["one"], ["two"], ["three"]];
    const a = assignAutoProjectColors(state(), projects);
    const b = assignAutoProjectColors(state(), [...projects].toReversed());
    expect(a.projectAutoColorById).toEqual(b.projectAutoColorById);
    expect(assignAutoProjectColors(a, projects)).toBe(a);
  });

  it("recognizes a project by any of its preference keys", () => {
    const existing = state({}, { "physical-key": "teal" });
    expect(assignAutoProjectColors(existing, [["logical-key", "physical-key"]])).toBe(existing);
    expect(resolveProjectColor(existing, ["logical-key", "physical-key"]).id).toBe("teal");
  });
});

describe("project color picks", () => {
  it("prefers the user's pick over the automatic color", () => {
    const current = state({ alpha: "pink" }, { alpha: "blue" });
    expect(resolveProjectColor(current, ["alpha"]).id).toBe("pink");
    expect(resolveProjectColorOverride(current, ["alpha"])).toBe("pink");
  });

  it("falls back to the hash slot for a project that was never assigned", () => {
    expect(resolveProjectColor(state(), ["fresh"]).id).toBe(
      PROJECT_COLORS[hashProjectKey("fresh")]!.id,
    );
  });

  it("stores picks under the primary key and clears stale aliases", () => {
    const current = state({ alias: "red" });
    const next = setProjectColor(current, ["primary", "alias"], "lime");
    expect(next.projectColorById).toEqual({ primary: "lime" });
  });

  it("clears a pick with null so the automatic color shows again", () => {
    const current = state({ alpha: "red" }, { alpha: "blue" });
    const next = setProjectColor(current, ["alpha"], null);
    expect(next.projectColorById).toEqual({});
    expect(resolveProjectColor(next, ["alpha"]).id).toBe("blue");
  });

  it("ignores unknown colors and no-op updates", () => {
    const current = state({ alpha: "red" });
    expect(setProjectColor(current, ["alpha"], "chartreuse")).toBe(current);
    expect(setProjectColor(current, ["alpha"], "red")).toBe(current);
    expect(setProjectColor(current, [], "red")).toBe(current);
  });

  it("sanitizes persisted records", () => {
    expect(sanitizeProjectColorRecord({ a: "red", b: "nope", "": "blue" })).toEqual({ a: "red" });
    expect(sanitizeProjectColorRecord(null)).toEqual({});
  });
});
