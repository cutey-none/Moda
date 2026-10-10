/**
 * Normalise image nodes so Milkdown can parse them.
 *
 * `remark-parse` emits `title: null` for an image written without one, which is
 * the common case:
 *
 *     ![说明](https://example.com/pic.png)
 *
 * Milkdown's image attribute is declared `validate: "string"`, so `null` makes
 * ProseMirror's node creation throw:
 *
 *     RangeError: Expected value of type string for attribute title on type
 *     image, got null
 *
 * The parser swallows that error, drops the image, and the document silently
 * loses it — including on the next save, which writes the truncated document
 * back to disk. Normalising the attribute to an empty string in the markdown AST
 * fixes it at the source, where the mismatch originates, rather than by
 * redefining a third-party schema.
 *
 * An empty title round-trips back to a titleless image, so nothing is added to
 * the user's markdown.
 */

import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import type { RemarkPlugin } from '@milkdown/kit/transformer';

/** The transformer: rewrite any non-string `title` on an image to `''`. */
const normaliseImageTitles: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'image', (node) => {
    if (typeof node.title !== 'string') node.title = '';
  });
};

/**
 * The plugin, shaped for `remarkPluginsCtx`.
 *
 * `options` is empty because the transformer takes none; the field is still
 * required by Milkdown's plugin record.
 */
export const remarkImageTitle: RemarkPlugin = {
  plugin: normaliseImageTitles,
  options: {},
};
