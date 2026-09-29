import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { AutoProjectRoutingSettings as AutoProjectRoutingSettingsValue } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULTS = DEFAULT_UNIFIED_SETTINGS.autoProjectRouting;
const SETTING_KEYS = ["autoProjectRouting"] as const;

function parseThreshold(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(value) && value >= 2 && value <= 100 ? value : null;
}

function parsePaths(raw: string): Array<string> {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Settings for threads started in the catch-all project: which project that
 * is, where candidate projects live, and whether unmatched threads get a new
 * project.
 */
export function AutoProjectRoutingSettings() {
  const settings = useScopedSettings().autoProjectRouting;
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<AutoProjectRoutingSettingsValue>) =>
    updateSettings({ autoProjectRouting: patch });
  const reset = <K extends keyof AutoProjectRoutingSettingsValue>(key: K, label: string) =>
    Equal.equals(settings[key], DEFAULTS[key]) ? null : (
      <SettingResetButton label={label} onClick={() => update({ [key]: DEFAULTS[key] })} />
    );

  return (
    <SettingsSection id="auto-project-routing-section" title="Auto project routing">
      <SettingsRow
        serverScoped
        settingKeys={SETTING_KEYS}
        {...searchableSetting("auto-project-routing")}
        description="Threads started in the auto-routing project move to the project their first message is about, before the agent starts."
        resetAction={reset("enabled", "auto project routing")}
        control={
          <ScopedSwitch
            settingKeys={SETTING_KEYS}
            checked={settings.enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Route new threads to projects"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={SETTING_KEYS}
        {...searchableSetting("auto-project-root")}
        description="Folder of the catch-all project whose new threads get routed."
        resetAction={reset("projectRoot", "auto-routing project")}
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.projectRoot}
            onCommit={(next) => update({ projectRoot: next.trim() })}
            placeholder={DEFAULTS.projectRoot}
            spellCheck={false}
            aria-label="Auto-routing project folder"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={SETTING_KEYS}
        {...searchableSetting("auto-project-search-roots")}
        description="Besides your projects, git repositories in these folders (comma separated) are candidates."
        resetAction={reset("searchRoots", "candidate folders")}
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.searchRoots.join(", ")}
            onCommit={(next) => update({ searchRoots: parsePaths(next) })}
            placeholder="~/Projects"
            spellCheck={false}
            aria-label="Candidate folders"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={SETTING_KEYS}
        {...searchableSetting("auto-project-reclassify")}
        description="A thread still in the auto-routing project after this many of your messages is classified again with the whole conversation."
        resetAction={reset("reclassifyAfterUserMessages", "classify again after")}
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-24"
            inputMode="numeric"
            value={String(settings.reclassifyAfterUserMessages)}
            onCommit={(next) => {
              const value = parseThreshold(next);
              if (value !== null) update({ reclassifyAfterUserMessages: value });
            }}
            aria-label="User messages before classifying again"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={SETTING_KEYS}
        {...searchableSetting("auto-project-create")}
        description={`When the second pass still finds no project, create one in ${settings.newProjectDirectory} with a git repository${settings.createGitHubRepository ? " and a private GitHub repository" : ""}.`}
        resetAction={reset("createProjects", "create projects")}
        control={
          <ScopedSwitch
            settingKeys={SETTING_KEYS}
            checked={settings.createProjects}
            onCheckedChange={(checked) => update({ createProjects: Boolean(checked) })}
            aria-label="Create projects for unmatched threads"
          />
        }
      >
        {settings.createProjects ? (
          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center">
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={settings.newProjectDirectory}
              onCommit={(next) => update({ newProjectDirectory: next.trim() })}
              placeholder={DEFAULTS.newProjectDirectory}
              spellCheck={false}
              aria-label="Folder for new projects"
            />
            <label className="flex items-center gap-2 text-muted-foreground text-xs">
              <ScopedSwitch
                settingKeys={SETTING_KEYS}
                checked={settings.createGitHubRepository}
                onCheckedChange={(checked) => update({ createGitHubRepository: Boolean(checked) })}
                aria-label="Create a private GitHub repository"
              />
              Private GitHub repository (gh CLI)
            </label>
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
