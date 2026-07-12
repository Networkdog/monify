// Deterministic workload placement on the hex grid.
//
// Each workload's home cell is a pure function of its name (a hash selects a
// spiral index), so a given name always lands in the same neighborhood. If that
// cell is taken, we probe forward along the spiral — deterministic as long as
// workloads are placed in a stable order. Multi-cell workloads then claim a
// contiguous cluster of free cells by breadth-first growth from the anchor.

import { hexNeighbors, hexSpiral, axialKey, type Axial } from './hex';

export interface PlacedWorkload {
  name: string;
  size: number;
  anchor: Axial;
  cells: Axial[];
}

/** FNV-1a hash of a string → uint32. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class HexPlacer {
  private readonly occupied = new Set<string>();
  private readonly spiral: Axial[];

  constructor(maxRadius = 40) {
    this.spiral = hexSpiral(maxRadius);
  }

  /** Place `name` occupying `size` cells; returns the claimed cluster. */
  place(name: string, size = 1): PlacedWorkload {
    const n = this.spiral.length;
    const start = hashString(name) % n;

    // Probe forward along the spiral for a free anchor.
    let anchor: Axial = this.spiral[start];
    for (let k = 0; k < n; k++) {
      const c = this.spiral[(start + k) % n];
      if (!this.occupied.has(axialKey(c[0], c[1]))) {
        anchor = c;
        break;
      }
    }

    const cells = this.claim(anchor, Math.max(1, size));
    for (const c of cells) this.occupied.add(axialKey(c[0], c[1]));
    return { name, size: cells.length, anchor, cells };
  }

  /**
   * Grow a contiguous cluster of up to `size` free cells from `anchor`.
   * Greedy-compact: each step adds the free frontier cell that shares the most
   * edges with the cells already chosen, so clusters stay blob-like (maximal
   * shared faces) instead of stretching into long chains. Deterministic:
   * ties break on a stable axial-key ordering.
   */
  private claim(anchor: Axial, size: number): Axial[] {
    const chosen: Axial[] = [];
    const chosenKeys = new Set<string>();
    const anchorKey = axialKey(anchor[0], anchor[1]);
    if (this.occupied.has(anchorKey)) return chosen;
    chosen.push(anchor);
    chosenKeys.add(anchorKey);

    while (chosen.length < size) {
      let best: Axial | null = null;
      let bestAdj = -1;
      let bestKey = '';
      const considered = new Set<string>();
      for (const cell of chosen) {
        for (const nb of hexNeighbors(cell[0], cell[1])) {
          const k = axialKey(nb[0], nb[1]);
          if (chosenKeys.has(k) || this.occupied.has(k) || considered.has(k)) continue;
          considered.add(k);
          // How many already-chosen cells does this candidate touch?
          const adj = this.countChosen(nb, chosenKeys);
          if (adj > bestAdj || (adj === bestAdj && k < bestKey)) {
            best = nb;
            bestAdj = adj;
            bestKey = k;
          }
        }
      }
      if (!best) break; // no free frontier cell left
      chosen.push(best);
      chosenKeys.add(bestKey);
    }
    return chosen;
  }

  /** Count how many of `chosenKeys` are neighbours of `cell`. */
  private countChosen(cell: Axial, chosenKeys: Set<string>): number {
    let adj = 0;
    for (const nb of hexNeighbors(cell[0], cell[1])) {
      if (chosenKeys.has(axialKey(nb[0], nb[1]))) adj++;
    }
    return adj;
  }
}
