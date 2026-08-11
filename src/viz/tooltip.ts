// Lightweight DOM tooltip overlay for "details on demand" on hover. Positioned
// in fixed (viewport) coordinates and nudged to stay on-screen near an edge.

import { INK, SURFACE } from '../color/tokens';

export interface TooltipData {
  title: string;
  body: string[];
}

export class Tooltip {
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;pointer-events:none;opacity:0;z-index:100;' +
      `background:color-mix(in srgb, ${SURFACE.panel} 94%, transparent);` +
      `border:1px solid ${SURFACE.border};` +
      'border-radius:8px;padding:9px 12px;max-width:280px;' +
      `font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:${INK.primary};` +
      'transition:opacity 0.12s;box-shadow:0 8px 24px rgba(0,0,0,0.55);';
    parent.appendChild(this.el);
  }

  show(data: TooltipData, clientX: number, clientY: number): void {
    const title = `<div style="color:${INK.accent};font-weight:650;margin-bottom:4px">${escapeHtml(
      data.title,
    )}</div>`;
    const body = data.body
      .map((l) => `<div style="color:${INK.muted}">${escapeHtml(l)}</div>`)
      .join('');
    this.el.innerHTML = title + body;
    this.el.style.opacity = '1';
    this.position(clientX, clientY);
  }

  position(cx: number, cy: number): void {
    const pad = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = cx + pad;
    let y = cy + pad;
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    if (x + tw > vw - pad) x = cx - tw - pad;
    if (y + th > vh - pad) y = cy - th - pad;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
  }

  hide(): void {
    this.el.style.opacity = '0';
  }

  destroy(): void {
    this.el.remove();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
