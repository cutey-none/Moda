/**
 * Diagrams drawn from fenced code blocks.
 *
 * A ```` ```mermaid ```` block keeps its source in the document, untouched, and
 * shows the rendered diagram beneath it. Crepe's code block already has a
 * preview panel for this — the Latex feature uses it for maths — so this module
 * only has to turn source into SVG; the panel, the "hide source" toggle and the
 * SVG sanitizing are the code block's own.
 *
 * Everything renders locally. Mermaid is loaded on first use rather than at
 * start-up, because it is several times the size of the rest of the app and
 * most documents never need it.
 */

/** Hands a finished preview to the code block, for a render that resolves later. */
type ApplyPreview = (value: null | string | HTMLElement) => void;

/**
 * Renders run one at a time, in the order they were asked for.
 *
 * The code block asks again on every keystroke and keeps whatever result
 * arrives last, but it cannot tell an old render from a new one. Strict order
 * means the last to arrive is always the latest text, so a slow render of an
 * earlier version can never land on top of the current one.
 */
let queue: Promise<void> = Promise.resolve();

let mermaidLoader: Promise<typeof import('mermaid').default> | undefined;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Diagram text comes from documents the user opened, which may not be
      // theirs: no script, no click handlers.
      securityLevel: 'strict',
      // Mermaid 12 defaults to the ELK layout engine, which this app cannot
      // ship (see `elk-stub.ts`). Dagre was Mermaid's default before it and
      // lays out every diagram type; only a diagram that names ELK itself now
      // gets the stub's explanation instead.
      layout: 'dagre',
      state: { layout: 'dagre' },
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue('--font-prose')
        .trim(),
    });
    return mermaid;
  });
  return mermaidLoader;
}

/** Each render needs a fresh element id; Mermaid builds the SVG under it. */
let renderCount = 0;

async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  renderCount += 1;
  const id = `moda-mermaid-${renderCount}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // Mermaid lays the diagram out in a scratch element on <body>, prefixed
    // `d`, and does not take it away again when the source fails to parse —
    // which, while a diagram is being typed, is most keystrokes.
    document.getElementById(`d${id}`)?.remove();
  }
}

/** A diagram that failed to render, shown in place of the diagram. */
function errorPreview(error: unknown): HTMLElement {
  const message = error instanceof Error ? error.message : String(error);
  const element = document.createElement('pre');
  element.className = 'diagram-error';
  element.textContent = `图表无法渲染：\n${message}`;
  return element;
}

/**
 * The code block's `renderPreview` hook.
 *
 * @returns `undefined` when a render has started and will arrive through
 *   `apply`, or `null` for a block that is not a diagram.
 */
export function renderDiagramPreview(
  language: string,
  content: string,
  apply: ApplyPreview,
): null | undefined {
  if (language.toLowerCase() !== 'mermaid' || content.trim() === '') return null;
  queue = queue.then(async () => {
    try {
      apply(await renderMermaid(content));
    } catch (error) {
      apply(errorPreview(error));
    }
  });
  return undefined;
}
