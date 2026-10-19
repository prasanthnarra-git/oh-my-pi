/**
 * Mermaid diagrams in transcript Markdown.
 *
 * The Markdown renderer emits ```mermaid fences as an ordinary escaped code
 * block tagged `tr-mermaid`, so the source stays readable while the library
 * loads and when a diagram fails to parse. {@link renderMermaidIn} then swaps
 * each block for its SVG. The library is imported on first use only, so
 * transcripts without diagrams never download it.
 */

import type { Mermaid } from "mermaid";

/** Fenced-block class the Markdown renderer gives mermaid fences. */
export const MERMAID_CLASS = "tr-mermaid";

/** SVG by `theme + "\0" + source`; re-renders of the same Markdown reuse it instead of re-laying out. */
const svgCache = new Map<string, string>();
/** Sources that failed to parse; kept as source and not retried when the same Markdown re-renders. */
const failed = new Set<string>();
let mermaidLoad: Promise<Mermaid> | null = null;
let initializedTheme: string | null = null;
let renderSeq = 0;

async function loadMermaid(theme: "dark" | "default"): Promise<Mermaid> {
	mermaidLoad ??= import("mermaid").then(mod => mod.default);
	const mermaid = await mermaidLoad;
	if (initializedTheme !== theme) {
		// `strict` runs labels through DOMPurify and disables click handlers and HTML labels:
		// transcript text is model output and must not inject markup.
		mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
		initializedTheme = theme;
	}
	return mermaid;
}

/** Replaces every not-yet-rendered mermaid block inside `root` with its SVG. */
export async function renderMermaidIn(root: HTMLElement): Promise<void> {
	const blocks = root.querySelectorAll<HTMLElement>(`pre.${MERMAID_CLASS}:not([data-rendered])`);
	if (blocks.length === 0) return;
	const theme = document.documentElement.dataset.theme === "light" ? "default" : "dark";
	for (const block of blocks) {
		const source = block.textContent ?? "";
		const key = `${theme}\0${source}`;
		if (failed.has(key)) continue;
		let svg = svgCache.get(key);
		if (svg === undefined) {
			const id = `tr-mermaid-${++renderSeq}`;
			try {
				const mermaid = await loadMermaid(theme);
				({ svg } = await mermaid.render(id, source));
				svgCache.set(key, svg);
			} catch {
				failed.add(key);
				// A failed render leaves its "Syntax error" scratch element at the end of <body>.
				document.getElementById(`d${id}`)?.remove();
				continue;
			}
		}
		// The block may have been replaced by a newer render while this one awaited.
		if (!block.isConnected) continue;
		block.dataset.rendered = "";
		block.innerHTML = svg;
	}
}
