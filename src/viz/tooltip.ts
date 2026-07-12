// Lightweight DOM tooltip overlay for "details on demand" on hover. Positioned
// in fixed (viewport) coordinates and nudged to stay on-screen near an edge.

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
      'background:rgba(10,12,18,0.92);border:1px solid rgba(120,160,220,0.35);' +
      'border-radius:6px;padding:8px 12px;max-width:280px;' +
      'font:12px/1.45 system-ui,sans-serif;color:#e8eaf2;' +
      'transition:opacity 0.12s;box-shadow:0 4px 14px rgba(0,0,0,0.5);';
    parent.appendChild(this.el);
  }

  show(data: TooltipData, clientX: number, clientY: number): void {
    const title = `<div style="color:#78b4f0;font-weight:700;margin-bottom:3px">${escapeHtml(
      data.title,
    )}</div>`;
    const body = data.body
      .map((l) => `<div style="color:#c4c8d4">${escapeHtml(l)}</div>`)
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
