/**
 * Find in the WYSIWYG document.
 *
 * A ProseMirror plugin that holds the current query, finds its matches and
 * paints them as decorations. Decorations rather than a DOM walk, because the
 * editor owns its DOM: anything painted into it by hand is wiped on the next
 * render, and a match painted that way would also never move with an edit.
 *
 * Matching is per textblock, over the block's text with inline marks ignored,
 * so a word that is half bold is still one match. It is case-insensitive, the
 * way ⌘F behaves in every Mac app.
 */

import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { $prose } from '@milkdown/kit/utils';

/** A match, as a document range. */
export interface FindMatch {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  matches: FindMatch[];
  /** Index into `matches` of the current one, or -1 when there are none. */
  current: number;
  decorations: DecorationSet;
}

/** What a transaction can ask of the plugin, through its meta. */
type FindMeta = { query: string } | { current: number };

export const findKey = new PluginKey<FindState>('moda-find');

/**
 * Stands in for a non-text inline node (an image, a hard break) so the offsets
 * in the joined text keep lining up with document positions.
 */
const OBJECT_REPLACEMENT = '￼';

/** Every occurrence of `query` in `doc`, in document order. */
export function findMatches(doc: Node, query: string): FindMatch[] {
  if (query === '') return [];
  const needle = query.toLowerCase();
  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child) => {
      text += child.isText ? (child.text ?? '') : OBJECT_REPLACEMENT;
    });
    // Lower-casing can change a string's length for a few scripts; skip the
    // block rather than report ranges that point at the wrong text.
    const haystack = text.toLowerCase();
    if (haystack.length !== text.length) return false;
    // The block's content starts one position past the node itself.
    const start = pos + 1;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      matches.push({ from: start + index, to: start + index + needle.length });
      index = haystack.indexOf(needle, index + needle.length);
    }
    return false;
  });
  return matches;
}

function decorate(doc: Node, matches: FindMatch[], current: number): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === current ? 'find-match find-match--current' : 'find-match',
      }),
    ),
  );
}

function build(doc: Node, query: string, current: number): FindState {
  const matches = findMatches(doc, query);
  const clamped = matches.length === 0 ? -1 : Math.min(Math.max(current, 0), matches.length - 1);
  return { query, matches, current: clamped, decorations: decorate(doc, matches, clamped) };
}

/** The plugin, to be handed to the editor before it is created. */
export const findPlugin = $prose(
  () =>
    new Plugin<FindState>({
      key: findKey,
      state: {
        init: (_config, state) => build(state.doc, '', -1),
        apply(tr, previous) {
          const meta = tr.getMeta(findKey) as FindMeta | undefined;
          if (meta !== undefined && 'query' in meta) return build(tr.doc, meta.query, 0);
          if (meta !== undefined && 'current' in meta) {
            return build(tr.doc, previous.query, meta.current);
          }
          // An edit can create or destroy matches anywhere, so they are found
          // again rather than mapped; documents are small enough for that.
          if (tr.docChanged && previous.query !== '') {
            return build(tr.doc, previous.query, previous.current);
          }
          return previous;
        },
      },
      props: {
        decorations: (state) => findKey.getState(state)?.decorations,
      },
    }),
);

/** The plugin's state, for callers outside this module. */
export function findState(state: EditorState): { matches: FindMatch[]; current: number } {
  const found = findKey.getState(state);
  return { matches: found?.matches ?? [], current: found?.current ?? -1 };
}
