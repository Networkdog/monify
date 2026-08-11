// Spec validation — turns silent misbehaviour (duplicate ids, NaN measures,
// out-of-range severities) into actionable messages before anything renders.

import type { DatasetSpec, Issue } from './types';

export interface ValidationReport {
  errors: Issue[];
  warnings: Issue[];
  get ok(): boolean;
}

const MAX_SAMPLES = 5;

function report(issues: Issue[]): ValidationReport {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  return {
    errors,
    warnings,
    get ok(): boolean {
      return errors.length === 0;
    },
  };
}

function checkIds<T>(spec: DatasetSpec<T>, issues: Issue[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const blank: number[] = [];
  spec.data.forEach((row, i) => {
    const id = spec.id(row, i);
    if (typeof id !== 'string' || id === '') {
      blank.push(i);
      return;
    }
    if (seen.has(id)) {
      if (duplicates.length < MAX_SAMPLES) duplicates.push(id);
    } else {
      seen.add(id);
    }
  });
  if (blank.length > 0) {
    issues.push({
      level: 'error',
      code: 'blank-id',
      message: `${blank.length} row(s) have an empty id; ids must be non-empty strings.`,
      samples: blank.slice(0, MAX_SAMPLES).map((i) => `row ${i}`),
    });
  }
  if (duplicates.length > 0) {
    issues.push({
      level: 'error',
      code: 'duplicate-id',
      message: 'Ids must be unique — duplicates silently overwrite each other when live updates arrive.',
      samples: duplicates,
    });
  }
}

function checkMeasures<T>(spec: DatasetSpec<T>, issues: Issue[]): void {
  for (const [name, m] of Object.entries(spec.measures ?? {})) {
    let invalid = 0;
    const samples: string[] = [];
    spec.data.forEach((row, i) => {
      const v = m.value(row, i);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        invalid++;
        if (samples.length < MAX_SAMPLES) samples.push(`row ${i} = ${String(v)}`);
      }
    });
    if (invalid > 0) {
      issues.push({
        level: 'warning',
        code: 'invalid-measure',
        subject: name,
        message: `Measure '${name}' has ${invalid} non-numeric value(s); they will be treated as 0.`,
        samples,
      });
    }
    if (m.domain && m.domain[0] >= m.domain[1]) {
      issues.push({
        level: 'error',
        code: 'invalid-domain',
        subject: name,
        message: `Measure '${name}' has an empty domain [${m.domain[0]}, ${m.domain[1]}]; the low bound must be smaller than the high bound.`,
      });
    }
  }
}

function checkHierarchy<T>(spec: DatasetSpec<T>, issues: Issue[]): void {
  const levels = Object.keys(spec.hierarchy ?? {});
  if (levels.length === 0) {
    issues.push({
      level: 'warning',
      code: 'no-hierarchy',
      message: 'No hierarchy levels declared; cells will be scattered with no locality.',
    });
  }
}

/** Validate a dataset spec. Cheap enough to run on every build in development. */
export function validateSpec<T>(spec: DatasetSpec<T>): ValidationReport {
  const issues: Issue[] = [];
  if (!Array.isArray(spec.data)) {
    issues.push({ level: 'error', code: 'invalid-data', message: 'spec.data must be an array of rows.' });
    return report(issues);
  }
  if (typeof spec.id !== 'function') {
    issues.push({ level: 'error', code: 'missing-id', message: 'spec.id must be a function returning a stable unique string.' });
    return report(issues);
  }
  checkIds(spec, issues);
  checkMeasures(spec, issues);
  checkHierarchy(spec, issues);
  return report(issues);
}

/** Format a report for a console warning. */
export function formatReport(r: ValidationReport): string {
  const lines: string[] = [];
  for (const i of [...r.errors, ...r.warnings]) {
    const where = i.subject ? ` (${i.subject})` : '';
    const eg = i.samples?.length ? ` e.g. ${i.samples.join(', ')}` : '';
    lines.push(`[monify:${i.level}] ${i.code}${where}: ${i.message}${eg}`);
  }
  return lines.join('\n');
}
