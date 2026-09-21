/**
 * Understated, lightweight inline SVG icons for JobPilot.
 *
 * No external icon CDN or web fonts.
 */

const svgWrapper = (content: string, size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;

export const ICONS = {
  minimize: svgWrapper('<line x1="5" y1="12" x2="19" y2="12"></line>'),
  close: svgWrapper(
    '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
  ),
  check: svgWrapper('<polyline points="20 6 9 17 4 12"></polyline>'),
  refresh: svgWrapper('<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"></path>'),
  alert: svgWrapper(
    '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
  ),
  info: svgWrapper(
    '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
  ),
  arrowRight: svgWrapper(
    '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>',
  ),
  external: svgWrapper(
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
  ),
} as const;

export const createIcon = (doc: Document, svgString: string): HTMLElement => {
  const span = doc.createElement("span");
  span.className = "jobpilot-icon";
  span.innerHTML = svgString;
  return span;
};
