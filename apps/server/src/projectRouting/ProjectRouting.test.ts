import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  buildRoutingConversation,
  describeProjectFromFiles,
  interpretProjectRoute,
  pickAvailableProjectName,
  type ProjectCandidate,
  projectRoutingStageForTurn,
  sanitizeProjectName,
} from "./ProjectRouting.ts";

const candidates: ReadonlyArray<ProjectCandidate> = [
  {
    name: "WingHopper",
    path: "/home/me/Projects/winghopper",
    description: "Parametric hydrofoil designer",
    projectId: ProjectId.make("project-winghopper"),
  },
  {
    name: "knobulator",
    path: "/home/me/Projects/knobulator",
    description: "",
    projectId: null,
  },
];

const route = (overrides: Partial<Parameters<typeof interpretProjectRoute>[0]>) =>
  interpretProjectRoute({
    projectPath: "none",
    confidence: 0,
    newProjectName: "",
    purpose: "",
    candidates,
    ...overrides,
  });

describe("interpretProjectRoute", () => {
  it("matches a candidate by its exact path", () => {
    const decision = route({ projectPath: "/home/me/Projects/winghopper", confidence: 0.92 });
    expect(decision.kind).toBe("match");
    expect(decision.kind === "match" && decision.candidate.name).toBe("WingHopper");
  });

  it("tolerates a trailing slash and falls back to an unambiguous name", () => {
    expect(route({ projectPath: "/home/me/Projects/knobulator/", confidence: 0.8 }).kind).toBe(
      "match",
    );
    const byName = route({ projectPath: "winghopper", confidence: 0.8 });
    expect(byName.kind === "match" && byName.candidate.path).toBe("/home/me/Projects/winghopper");
  });

  it("treats low confidence as no project", () => {
    expect(route({ projectPath: "/home/me/Projects/winghopper", confidence: 0.69 }).kind).toBe(
      "none",
    );
    expect(
      route({ projectPath: "/home/me/Projects/winghopper", confidence: Number.NaN }).kind,
    ).toBe("none");
  });

  it("rejects paths that are not candidates", () => {
    expect(route({ projectPath: "/etc", confidence: 1 }).kind).toBe("none");
    expect(route({ projectPath: "", confidence: 1 }).kind).toBe("none");
  });

  it("carries a sanitized name and purpose for a new project", () => {
    const decision = route({
      projectPath: "NONE",
      confidence: 0.95,
      newProjectName: "Espresso Grinder Mods!",
      purpose: "  Track   grinder modifications. ",
    });
    expect(decision).toEqual({
      kind: "none",
      newProjectName: "espresso-grinder-mods",
      purpose: "Track grinder modifications.",
    });
    expect(route({ projectPath: "none", confidence: 0.9 })).toEqual({
      kind: "none",
      newProjectName: null,
      purpose: null,
    });
  });
});

describe("projectRoutingStageForTurn", () => {
  it("classifies the opening message and the reclassify threshold only", () => {
    const stages = [1, 2, 5, 6, 7, 12].map((userMessageCount) =>
      projectRoutingStageForTurn({ userMessageCount, reclassifyAfter: 6, movedByUser: false }),
    );
    expect(stages).toEqual(["first-message", null, null, "reclassify", null, null]);
  });

  it("never routes a thread the user moved by hand", () => {
    expect(
      projectRoutingStageForTurn({ userMessageCount: 1, reclassifyAfter: 6, movedByUser: true }),
    ).toBeNull();
    expect(
      projectRoutingStageForTurn({ userMessageCount: 6, reclassifyAfter: 6, movedByUser: true }),
    ).toBeNull();
  });
});

describe("project names", () => {
  it("produces short kebab-case names", () => {
    expect(sanitizeProjectName("Café Menu Planner")).toBe("cafe-menu-planner");
    expect(sanitizeProjectName("***")).toBe("new-project");
    const long = sanitizeProjectName(
      "a very long project name that keeps going well past the limit",
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  it("suffixes a taken name instead of reusing it", () => {
    const taken = new Set(["garden", "garden-2"]);
    expect(pickAvailableProjectName("garden", (name) => taken.has(name))).toBe("garden-3");
    expect(pickAvailableProjectName("fresh", (name) => taken.has(name))).toBe("fresh");
  });

  it("gives up when every attempt collides", () => {
    expect(pickAvailableProjectName("garden", () => true, 3)).toBeNull();
  });
});

describe("buildRoutingConversation", () => {
  it("uses the opening message alone on the first turn", () => {
    expect(buildRoutingConversation([{ role: "user", text: " Fix the wing tip " }])).toBe(
      "Fix the wing tip",
    );
  });

  it("keeps the opening request and the newest messages within budget", () => {
    const messages = [
      { role: "user" as const, text: "Opening request" },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
        text: `message ${index} ${"x".repeat(900)}`,
      })),
    ];
    const conversation = buildRoutingConversation(messages);
    expect(conversation.startsWith("User: Opening request")).toBe(true);
    expect(conversation).toContain("earlier messages omitted");
    expect(conversation).toContain("message 29");
    expect(conversation).not.toContain("message 0 ");
  });
});

describe("describeProjectFromFiles", () => {
  it("combines the package description with the README opening", () => {
    expect(
      describeProjectFromFiles({
        packageJson: JSON.stringify({ description: "Foil CAD" }),
        readme: "# WingHopper\n\n![badge](x)\nDesign hydrofoils in the browser.",
      }),
    ).toBe("Foil CAD. WingHopper Design hydrofoils in the browser.");
    expect(describeProjectFromFiles({ packageJson: "not json" })).toBe("");
  });
});
