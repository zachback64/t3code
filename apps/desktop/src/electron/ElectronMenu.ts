import type { ContextMenuItem } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export interface ElectronMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ElectronMenuContextInput {
  readonly window: Electron.BrowserWindow;
  readonly items: readonly ContextMenuItem[];
  readonly position: Option.Option<ElectronMenuPosition>;
}

export interface ElectronMenuTemplateInput {
  readonly window: Electron.BrowserWindow;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
  readonly frame?: Electron.WebFrameMain;
}

const ElectronMenuOperation = Schema.Literals([
  "set-application-menu",
  "popup-template",
  "show-context-menu",
]);

export class ElectronMenuOperationError extends Schema.TaggedError<ElectronMenuOperationError>()(
  "ElectronMenuOperationError",
  {
    operation: ElectronMenuOperation,
    platform: Schema.String,
    windowId: Schema.NullOr(Schema.Number),
    itemCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const window = this.windowId === null ? "" : ` for window ${this.windowId}`;
    return `Electron menu operation ${JSON.stringify(this.operation)} failed${window} with ${this.itemCount} items on ${this.platform}.`;
  }
}

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    readonly setApplicationMenu: (
      template: readonly Electron.MenuItemConstructorOptions[],
    ) => Effect.Effect<void>;
    readonly showContextMenu: (
      input: ElectronMenuContextInput,
    ) => Effect.Effect<Option.Option<string>>;
    readonly popupTemplate: (input: ElectronMenuTemplateInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronMenu") {}

const SWATCH_PATTERN = /^#[0-9a-f]{6}$/i;
const SWATCH_POINTS = 12;
const SWATCH_SCALE = 2;

/**
 * BGRA pixels for an anti-aliased filled circle with a faint edge, drawn at
 * 2x so the menu swatch stays crisp on Retina displays.
 */
export function makeSwatchBitmap(hex: string): { buffer: Buffer; size: number } {
  const size = SWATCH_POINTS * SWATCH_SCALE;
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const buffer = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const coverage = Math.max(0, Math.min(1, radius - distance + 0.5));
      if (coverage === 0) continue;
      // Darken the outer 1.5px a little so light swatches hold their edge.
      const edge = distance > radius - 1.5 ? 0.82 : 1;
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(blue * edge);
      buffer[offset + 1] = Math.round(green * edge);
      buffer[offset + 2] = Math.round(red * edge);
      buffer[offset + 3] = Math.round(coverage * 255);
    }
  }
  return { buffer, size };
}

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    // Header items are decorative section labels for the web fallback only —
    // Electron's native menu has no equivalent affordance, so we skip them.
    if (sourceItem.header === true) {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
      ...(sourceItem.separatorBefore === true ? { separatorBefore: true } : {}),
      ...(typeof sourceItem.checked === "boolean" ? { checked: sourceItem.checked } : {}),
      ...(typeof sourceItem.swatch === "string" && SWATCH_PATTERN.test(sourceItem.swatch)
        ? { swatch: sourceItem.swatch.toLowerCase() }
        : {}),
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

// Renderer positions arrive in CSS pixels; popup() expects window points, so
// page zoom must be factored in or menus drift proportionally to their
// distance from the window origin.
const normalizePosition = (
  position: Option.Option<ElectronMenuPosition>,
  zoomFactor: number,
): Option.Option<ElectronMenuPosition> =>
  Option.filter(
    position,
    ({ x, y }) =>
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && Number.isFinite(zoomFactor),
  ).pipe(
    Option.map(({ x, y }) => ({ x: Math.floor(x * zoomFactor), y: Math.floor(y * zoomFactor) })),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  let destructiveMenuIconCache: Option.Option<Electron.NativeImage> | undefined;
  const swatchIconCache = new Map<string, Option.Option<Electron.NativeImage>>();

  const getSwatchIcon = (hex: string): Option.Option<Electron.NativeImage> => {
    const cached = swatchIconCache.get(hex);
    if (cached !== undefined) return cached;
    let icon: Option.Option<Electron.NativeImage>;
    try {
      const { buffer, size } = makeSwatchBitmap(hex);
      const image = Electron.nativeImage.createFromBitmap(buffer, {
        width: size,
        height: size,
        scaleFactor: SWATCH_SCALE,
      });
      icon = image.isEmpty() ? Option.none() : Option.some(image);
    } catch {
      icon = Option.none();
    }
    swatchIconCache.set(hex, icon);
    return icon;
  };

  const getDestructiveMenuIcon = (): Option.Option<Electron.NativeImage> => {
    if (platform !== "darwin") {
      return Option.none();
    }
    if (destructiveMenuIconCache !== undefined) {
      return destructiveMenuIconCache;
    }

    try {
      const icon = Electron.nativeImage.createFromNamedImage("trash").resize({
        width: 12,
        height: 12,
      });
      icon.setTemplateImage(true);
      destructiveMenuIconCache = icon.isEmpty() ? Option.none() : Option.some(icon);
    } catch {
      destructiveMenuIconCache = Option.none();
    }

    return destructiveMenuIconCache;
  };

  const buildTemplate = (
    entries: readonly ContextMenuItem[],
    complete: (selectedItemId: Option.Option<string>) => void,
  ): Electron.MenuItemConstructorOptions[] => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    let hasInsertedDestructiveSeparator = false;
    let sectionStartedByExplicitSeparator = false;
    const appendSeparator = () => {
      if (template.length === 0 || template.at(-1)?.type === "separator") return;
      template.push({ type: "separator" });
    };

    for (const item of entries) {
      if (item.separatorBefore) {
        appendSeparator();
        sectionStartedByExplicitSeparator = true;
      }
      if (
        item.destructive &&
        !hasInsertedDestructiveSeparator &&
        !sectionStartedByExplicitSeparator &&
        template.length > 0
      ) {
        appendSeparator();
        hasInsertedDestructiveSeparator = true;
      }

      const itemOption: Electron.MenuItemConstructorOptions = {
        label: item.label,
        enabled: !item.disabled,
        ...(typeof item.checked === "boolean" ? { type: "checkbox", checked: item.checked } : {}),
      };
      if (item.children && item.children.length > 0) {
        itemOption.submenu = buildTemplate(item.children, complete);
      } else {
        itemOption.click = () => complete(Option.some(item.id));
      }
      if (item.swatch) {
        const swatchIcon = getSwatchIcon(item.swatch);
        if (Option.isSome(swatchIcon)) {
          itemOption.icon = swatchIcon.value;
        }
      }
      if (item.destructive && (!item.children || item.children.length === 0)) {
        const destructiveIcon = getDestructiveMenuIcon();
        if (Option.isSome(destructiveIcon)) {
          itemOption.icon = destructiveIcon.value;
        }
      }

      template.push(itemOption);
    }

    return template;
  };

  return ElectronMenu.of({
    setApplicationMenu: (template) =>
      Effect.try({
        try: () => {
          Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
        },
        catch: (cause) =>
          new ElectronMenuOperationError({
            operation: "set-application-menu",
            platform,
            windowId: null,
            itemCount: template.length,
            cause,
          }),
      }).pipe(Effect.orDie),
    popupTemplate: (input) =>
      input.template.length === 0
        ? Effect.void
        : Effect.try({
            try: () =>
              Electron.Menu.buildFromTemplate([...input.template]).popup({
                window: input.window,
                ...(input.frame ? { frame: input.frame } : {}),
              }),
            catch: (cause) =>
              new ElectronMenuOperationError({
                operation: "popup-template",
                platform,
                windowId: input.window.id,
                itemCount: input.template.length,
                cause,
              }),
          }).pipe(Effect.orDie),
    showContextMenu: (input) =>
      Effect.callback<Option.Option<string>>((resume) => {
        const normalizedItems = normalizeContextMenuItems(input.items);
        if (normalizedItems.length === 0) {
          resume(Effect.succeedNone);
          return;
        }

        let completed = false;
        const complete = (selectedItemId: Option.Option<string>) => {
          if (completed) {
            return;
          }
          completed = true;
          resume(Effect.succeed(selectedItemId));
        };

        try {
          const menu = Electron.Menu.buildFromTemplate(buildTemplate(normalizedItems, complete));
          const popupPosition = normalizePosition(
            input.position,
            input.window.webContents.getZoomFactor(),
          );
          const popupOptions = Option.match(popupPosition, {
            onNone: (): Electron.PopupOptions => ({
              window: input.window,
              callback: () => complete(Option.none()),
            }),
            onSome: (position): Electron.PopupOptions => ({
              window: input.window,
              x: position.x,
              y: position.y,
              callback: () => complete(Option.none()),
            }),
          });
          menu.popup(popupOptions);
        } catch (cause) {
          if (completed) {
            return;
          }
          completed = true;
          resume(
            Effect.die(
              new ElectronMenuOperationError({
                operation: "show-context-menu",
                platform,
                windowId: input.window.id,
                itemCount: normalizedItems.length,
                cause,
              }),
            ),
          );
        }
      }),
  });
});

export const layer = Layer.effect(ElectronMenu, make);
