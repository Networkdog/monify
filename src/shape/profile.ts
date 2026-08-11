// Data profiling — infers what each field is, finds hierarchy candidates by
// functional dependency, recommends a placement, and flags quality problems.

import { describe, type MeasureStats } from './aggregate';
import { normalizeKey } from './hierarchy';
import type { Issue } from './types';

export type FieldKind = 'identifier' | 'categorical' | 'quantitative' | 'temporal' | 'constant' | 'empty';

export interface FieldProfile {
  name: string;
  kind: FieldKind;
  /** Distinct value count. */
  cardinality: number;
  /** Fraction of rows with a missing value, 0..1. */
  missing: number;
  /** Up to 5 representative values. */
  samples: string[];
  /** Present for quantitative fields. */
  stats?: MeasureStats;
}

export interface HierarchyCandidate {
  /** Coarse→fine field names that form a containment chain. */
  levels: string[];
  /** Distinct groups at each level. */
  cardinalities: number[];
  /** How cleanly each child sits inside one parent, 0..1 (1 = strict containment). */
  strength: number;
}

export interface Recommendation {
  /** Suggested HexGrid placement strategy. */
  placement: 'hash' | 'grouped' | 'hierarchical' | 'dense' | 'affinity' | 'relational';
  /** Suggested layout levels, coarse→fine. */
  layout: string[];
  reason: string;
}

export interface DataProfile {
  rowCount: number;
  fields: FieldProfile[];
  hierarchyCandidates: HierarchyCandidate[];
  recommendation: Recommendation | null;
  issues: Issue[];
  /** Human-readable summary of everything above. */
  explain(): string;
}

const MAX_SAMPLES = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

function isMissing(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function classify(name: string, values: readonly unknown[], rowCount: number): FieldProfile {
  const present = values.filter((v) => !isMissing(v));
  const missing = rowCount === 0 ? 0 : (rowCount - present.length) / rowCount;
  const distinct = new Set(present.map((v) => String(v)));
  const samples = [...distinct].slice(0, MAX_SAMPLES);
  const cardinality = distinct.size;

  if (present.length === 0) {
    return { name, kind: 'empty', cardinality: 0, missing, samples };
  }
  if (cardinality === 1) {
    return { name, kind: 'constant', cardinality, missing, samples };
  }
  const numeric = present.every((v) => typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))));
  if (numeric) {
    const nums = present.map((v) => Number(v));
    // Small integer sets read as categories (status codes, tiers) rather than measures.
    const allInts = nums.every((n) => Number.isInteger(n));
    if (allInts && cardinality <= 12) {
      return { name, kind: 'categorical', cardinality, missing, samples };
    }
    return { name, kind: 'quantitative', cardinality, missing, samples, stats: describe(nums) };
  }
  const temporal = present.every(
    (v) => v instanceof Date || (typeof v === 'string' && DATE_RE.test(v)),
  );
  if (temporal) return { name, kind: 'temporal', cardinality, missing, samples };
  if (cardinality === present.length && present.length > 1) {
    return { name, kind: 'identifier', cardinality, missing, samples };
  }
  return { name, kind: 'categorical', cardinality, missing, samples };
}

/**
 * How strongly `child` determines `parent`: the share of child groups that map
 * to exactly one parent value. 1 means strict containment (child ⊂ parent).
 */
function containment(childValues: readonly string[], parentValues: readonly string[]): number {
  const parentsOf = new Map<string, Set<string>>();
  for (let i = 0; i < childValues.length; i++) {
    let set = parentsOf.get(childValues[i]);
    if (!set) {
      set = new Set();
      parentsOf.set(childValues[i], set);
    }
    set.add(parentValues[i]);
  }
  if (parentsOf.size === 0) return 0;
  let clean = 0;
  for (const set of parentsOf.values()) if (set.size === 1) clean++;
  return clean / parentsOf.size;
}

const CONTAINMENT_MIN = 0.9;

/** Chain categorical fields coarse→fine wherever one nests cleanly inside another. */
function findHierarchies(
  fields: readonly FieldProfile[],
  columns: Map<string, string[]>,
): HierarchyCandidate[] {
  const cats = fields
    .filter((f) => f.kind === 'categorical' && f.cardinality > 1)
    .sort((a, b) => a.cardinality - b.cardinality);
  if (cats.length < 2) return [];

  const candidates: HierarchyCandidate[] = [];
  for (let i = 0; i < cats.length; i++) {
    const levels = [cats[i].name];
    const strengths: number[] = [];
    let current = cats[i];
    for (let j = i + 1; j < cats.length; j++) {
      const next = cats[j];
      if (levels.includes(next.name)) continue;
      const s = containment(
        columns.get(next.name) ?? [],
        columns.get(current.name) ?? [],
      );
      if (s >= CONTAINMENT_MIN) {
        levels.push(next.name);
        strengths.push(s);
        current = next;
      }
    }
    if (levels.length >= 2) {
      candidates.push({
        levels,
        cardinalities: levels.map((n) => cats.find((c) => c.name === n)?.cardinality ?? 0),
        strength: strengths.reduce((a, b) => a + b, 0) / strengths.length,
      });
    }
  }
  // Longest, cleanest chain first; drop chains fully contained in a better one.
  candidates.sort((a, b) => b.levels.length - a.levels.length || b.strength - a.strength);
  return candidates.filter(
    (c, i) => !candidates.some((o, j) => j < i && c.levels.every((l) => o.levels.includes(l))),
  );
}

function recommend(
  rowCount: number,
  candidates: readonly HierarchyCandidate[],
): Recommendation | null {
  if (candidates.length === 0) {
    return {
      placement: 'hash',
      layout: [],
      reason: 'No containment hierarchy was detected, so cells are scattered deterministically by id.',
    };
  }
  const best = candidates[0];
  const depth = best.levels.length;
  if (depth >= 3 && rowCount >= 2000) {
    return {
      placement: 'affinity',
      layout: best.levels,
      reason: `A ${depth}-level hierarchy over ${rowCount.toLocaleString()} rows suits an organic affinity map, which keeps related groups adjacent so a correlated incident reads as one patch.`,
    };
  }
  if (depth >= 2) {
    return {
      placement: 'dense',
      layout: best.levels,
      reason: `A ${depth}-level hierarchy packs into a gap-free territory map with clear group boundaries.`,
    };
  }
  return {
    placement: 'grouped',
    layout: best.levels,
    reason: 'A single grouping level clusters members into contiguous blobs.',
  };
}

const HIGH_CARDINALITY = 40;

function qualityIssues(fields: readonly FieldProfile[], rowCount: number): Issue[] {
  const issues: Issue[] = [];
  for (const f of fields) {
    if (f.missing > 0.2) {
      issues.push({
        level: 'warning',
        code: 'sparse-field',
        subject: f.name,
        message: `'${f.name}' is missing in ${(f.missing * 100).toFixed(0)}% of rows.`,
      });
    }
    if (f.kind === 'categorical' && f.cardinality > HIGH_CARDINALITY) {
      issues.push({
        level: 'warning',
        code: 'high-cardinality',
        subject: f.name,
        message: `'${f.name}' has ${f.cardinality} categories; colors will be hard to tell apart above ~${HIGH_CARDINALITY}.`,
      });
    }
    if (f.kind === 'quantitative' && f.stats && f.stats.invalid > 0) {
      issues.push({
        level: 'warning',
        code: 'non-finite-values',
        subject: f.name,
        message: `'${f.name}' has ${f.stats.invalid} non-finite value(s) that will be treated as 0.`,
      });
    }
  }
  if (rowCount === 0) {
    issues.push({ level: 'error', code: 'empty-dataset', message: 'The dataset has no rows.' });
  }
  return issues;
}

/**
 * Profile raw rows. `fields` maps a field name to an accessor; pass the columns
 * you might visualize and the profiler works out what they are.
 */
export function profileRows<T>(
  rows: readonly T[],
  fields: Record<string, (row: T, index: number) => unknown>,
): DataProfile {
  const names = Object.keys(fields);
  const raw = new Map<string, unknown[]>();
  const columns = new Map<string, string[]>();
  for (const name of names) {
    const accessor = fields[name];
    const values = rows.map((r, i) => accessor(r, i));
    raw.set(name, values);
    columns.set(name, values.map(normalizeKey));
  }

  const profiles = names.map((n) => classify(n, raw.get(n) ?? [], rows.length));
  const candidates = findHierarchies(profiles, columns);
  const recommendation = recommend(rows.length, candidates);
  const issues = qualityIssues(profiles, rows.length);

  return {
    rowCount: rows.length,
    fields: profiles,
    hierarchyCandidates: candidates,
    recommendation,
    issues,
    explain(): string {
      const lines: string[] = [`${rows.length.toLocaleString()} rows · ${profiles.length} fields`];
      for (const f of profiles) {
        const miss = f.missing > 0 ? `, ${(f.missing * 100).toFixed(0)}% missing` : '';
        lines.push(`  ${f.name}: ${f.kind} (${f.cardinality} distinct${miss})`);
      }
      if (candidates.length > 0) {
        lines.push('Hierarchy candidates:');
        for (const c of candidates.slice(0, 3)) {
          lines.push(`  ${c.levels.join(' › ')} (strength ${c.strength.toFixed(2)})`);
        }
      }
      if (recommendation) {
        lines.push(`Recommended placement: ${recommendation.placement} — ${recommendation.reason}`);
      }
      for (const i of issues) lines.push(`  [${i.level}] ${i.message}`);
      return lines.join('\n');
    },
  };
}
