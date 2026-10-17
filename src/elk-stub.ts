/**
 * Stands in for `elkjs`, which Mermaid would otherwise bundle.
 *
 * ELK is an alternative layout engine Mermaid uses only when a diagram asks for
 * it (`layout: elk`); every other diagram uses dagre. It is licensed EPL-2.0
 * without the notice that would allow it under the GPL family, so it cannot
 * ship inside an AGPL-3.0 app. `vite.config.ts` points the import here, and a
 * diagram that asks for ELK gets this message in place of the diagram.
 */
export default class ElkUnavailable {
  layout(): Promise<never> {
    return Promise.reject(
      new Error('Moda 不包含 ELK 布局引擎（许可证与 AGPL 不兼容），请去掉 `layout: elk`，使用默认布局。'),
    );
  }
}
