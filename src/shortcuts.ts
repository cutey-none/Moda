/**
 * Keyboard shortcuts, aligned with Typora.
 *
 * Milkdown already ships a workable default set — `⌘B` bold, `⌘I` italic,
 * `⌘E` inline code, `⌘⌥1..6` headings, `⌘⌥7`/`⌘⌥8` lists, `⌘⇧B` blockquote.
 * What this module adds is the set a Typora user reaches for without thinking:
 * `⌘1..6` for headings, `⌘0` back to body text, `⌘K` for a link, `⌘\`` for
 * inline code, `⌘⇧C` for a code block, and `⌘U` treated as italic because
 * markdown has no underline.
 *
 * The existing defaults are deliberately left in place rather than replaced, so
 * both the Typora muscle memory and Milkdown's own bindings work.
 *
 * Commands are invoked through `commandsCtx.call(...)` with the same string keys
 * Milkdown registers its own keymaps under (`ToggleStrong`, `WrapInHeading`, …).
 * Calling a missing key throws, so the keys here are taken from the preset
 * sources rather than guessed; `scripts/check-shortcuts.mjs` exercises them.
 */

import { commandsCtx, type KeymapItem } from '@milkdown/kit/core';
import { $shortcut, type Keymap } from '@milkdown/kit/utils';
import type { Ctx } from '@milkdown/kit/ctx';

/**
 * A command to run when a key is pressed.
 *
 * Returns a `KeymapItem` rather than a bare `Command`, because the command has
 * to be looked up in the editor's `ctx` — which only exists once the key is
 * actually pressed. `onRun` is handed that `ctx` and returns the ProseMirror
 * command to execute.
 *
 * @param key - the command's registered key, e.g. `ToggleStrong`.
 * @param payload - the command's argument, for the ones that take one.
 */
function run(key: string, payload?: unknown): KeymapItem {
  return {
    key: '',
    onRun: (ctx: Ctx) => {
      const commands = ctx.get(commandsCtx);
      return () => commands.call(key, payload);
    },
  };
}

/**
 * Bind a key to a command.
 *
 * `KeymapItem.key` is what the manager buckets on, so it has to be filled in
 * here rather than inside {@link run}. Keymaps sharing a key are chained with
 * `chainCommands`, which stops at the first handler that reports success, so
 * `priority` decides the winner: the manager's default is 50, and a higher
 * number runs first.
 */
function bind(
  key: string,
  command: string,
  payload?: unknown,
  priority?: number,
): KeymapItem {
  return { ...run(command, payload), key, ...(priority === undefined ? {} : { priority }) };
}

/** Every key this app binds, as ProseMirror key names. */
export const shortcutKeymap: Keymap = {
  // ------------------------------------------------------------------ inline
  'Mod-b': bind('Mod-b', 'ToggleStrong'),
  'Mod-i': bind('Mod-i', 'ToggleEmphasis'),
  // Markdown has no underline, so `⌘U` is treated as italic — what a Typora user
  // expects from the key. The higher priority also settles the collision with
  // Milkdown's own `⌘I`, whose emphasis toggle would otherwise be chained after
  // this one and undo it.
  'Mod-u': bind('Mod-u', 'ToggleEmphasis', undefined, 100),
  // `⌘\`` is Typora's inline code; Milkdown's `⌘E` remains available too.
  'Mod-`': bind('Mod-`', 'ToggleInlineCode'),
  // `⌘K` is deliberately absent: Milkdown's link mark requires an `href`, and
  // invoking the command without one throws. The app handles `⌘K` itself so it
  // can ask for the URL first — see `ModaApp.insertLink`.

  // --------------------------------------------------------------- paragraphs
  // `⌘1`..`⌘6` set a heading level, `⌘0` returns the block to body text.
  'Mod-1': bind('Mod-1', 'WrapInHeading', 1),
  'Mod-2': bind('Mod-2', 'WrapInHeading', 2),
  'Mod-3': bind('Mod-3', 'WrapInHeading', 3),
  'Mod-4': bind('Mod-4', 'WrapInHeading', 4),
  'Mod-5': bind('Mod-5', 'WrapInHeading', 5),
  'Mod-6': bind('Mod-6', 'WrapInHeading', 6),
  'Mod-0': bind('Mod-0', 'TurnIntoText'),

  // ------------------------------------------------------------------- blocks
  'Mod-Shift-c': bind('Mod-Shift-c', 'CreateCodeBlock'),
  'Mod-Shift-b': bind('Mod-Shift-b', 'WrapInBlockquote'),
  'Mod-Shift-8': bind('Mod-Shift-8', 'WrapInBulletList'),
  'Mod-Shift-7': bind('Mod-Shift-7', 'WrapInOrderedList'),
};

/** The shortcut plugin, to be handed to the editor before it is created. */
export const typoraShortcuts = $shortcut(() => shortcutKeymap);

/**
 * A human-readable listing of the shortcuts this app binds, for the README and
 * any future help screen. Kept beside the map so the two cannot drift.
 */
export const shortcutReference: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: '⌘B', action: '加粗' },
  { keys: '⌘I / ⌘U', action: '斜体' },
  { keys: '⌘` / ⌘E', action: '行内代码' },
  { keys: '⌘K', action: '插入链接' },
  { keys: '⌘1 – ⌘6', action: '一至六级标题' },
  { keys: '⌘0', action: '正文' },
  { keys: '⌘⇧C', action: '代码块' },
  { keys: '⌘⇧B', action: '引用块' },
  { keys: '⌘⇧8', action: '无序列表' },
  { keys: '⌘⇧7', action: '有序列表' },
];
