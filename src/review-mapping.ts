// Pure functions that turn (agent findings JSON, PR diff) into a GitHub review payload.
// No SDK, no network, no Ink imports — everything here is unit-tested offline.
//
// The hard problem: findings carry no line numbers, and GitHub inline comments can only
// attach to lines that appear in the diff. So we parse the diff into added (RIGHT-side)
// lines, match each finding's verbatim `evidence` against them, post the matches inline,
// and dump everything else into the review summary body.

export interface Finding {
  file: string;
  severity: string; // blocker | major | minor
  evidence: string;
  suggested_fix: string;
  check_type: string; // mechanical | semantic
  rule: string;
}

export interface Findings {
  project_name: string;
  health_score: number;
  generated_at: string;
  findings: Finding[];
}

export interface AddedLine {
  newLine: number; // 1-based line number in the new (post-PR) file
  text: string; // line content without the leading '+'
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface ReviewPayload {
  body: string;
  comments: ReviewComment[];
}

// The mechanical half of the review comes straight from lintRun's JSON — no LLM. Pull the
// findings (violations.details) and the semantic queue out of that response string. Throws
// on an error response so CI surfaces it rather than silently reviewing nothing.
export function parseLintRun(lintRunJson: string): { mechanical: Finding[]; semanticQueue: string[]; projectName: string } {
  const r = JSON.parse(lintRunJson) as {
    error?: string; message?: string; nothing_to_lint?: boolean;
    project_name?: string;
    violations?: { details?: Array<Partial<Finding> & { code?: string }> };
    semantic_review_queue?: string[];
  };
  if (r.error) throw new Error(`lint_run failed: ${r.error}${r.message ? ` — ${r.message}` : ''}`);
  if (r.nothing_to_lint) return { mechanical: [], semanticQueue: [], projectName: r.project_name ?? 'unknown' };

  const mechanical = (r.violations?.details ?? []).map(d => ({
    file: d.file ?? '',
    severity: d.severity ?? 'minor',
    evidence: d.evidence ?? '',
    suggested_fix: d.suggested_fix ?? '',
    check_type: 'mechanical',
    rule: d.code ?? d.rule ?? 'mechanical',
  }));
  return { mechanical, semanticQueue: r.semantic_review_queue ?? [], projectName: r.project_name ?? 'unknown' };
}

// Health score mirrors the lint-deep skill's formula, computed in code (not by the LLM) so
// it's deterministic. weighted_penalty = 3·blockers + 2·majors + 1·minors over a max of
// 3·checks. ruleChecks is the number of (rule × file) pairs evaluated; 0 → score 100.
export function computeHealthScore(findings: Finding[], ruleChecks: number): number {
  if (ruleChecks <= 0) return 100;
  const penalty = findings.reduce((sum, f) => sum + severityRank(f.severity), 0);
  const score = Math.round(100 * (1 - penalty / (3 * ruleChecks)));
  return Math.max(0, Math.min(100, score));
}

// blocker > major > minor; higher = more severe. Mirrors severity_rank in sidecars/lint/src/main.rs.
// Unknown severities rank 0 so a stray value can never satisfy a --fail-on threshold.
export function severityRank(severity: string): number {
  switch (severity) {
    case 'blocker': return 3;
    case 'major':   return 2;
    case 'minor':   return 1;
    default:        return 0;
  }
}

// The semantic sub-agents emit a JSON ARRAY (not the wrapping object). Pull the last
// fenced ```json block and parse it as Finding[]. Throws on malformed/missing (boundary).
export function extractFindingsArray(assistantText: string): Finding[] {
  const fences = [...assistantText.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fences.length === 0) throw new Error('no ```json block found in semantic review output');
  const raw = fences[fences.length - 1]![1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`semantic review JSON did not parse (likely truncated): ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('semantic review JSON is not an array');
  return (parsed as Finding[]).map(f => ({ ...f, check_type: 'semantic' }));
}

// Parse a unified diff into the added (RIGHT-side) lines per file path. Only added lines
// are recorded because those are the lines an inline comment can safely attach to.
//
// Paths are taken from the `+++ b/<path>` header (a pure deletion has `+++ /dev/null` and
// contributes no added lines, so it's naturally skipped). The new-file line counter is
// seeded from each `@@ -a,b +c,d @@` hunk header and advanced on added + context lines.
export function parseUnifiedDiff(diff: string): Map<string, AddedLine[]> {
  const byFile = new Map<string, AddedLine[]>();
  let path: string | null = null;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (path && !byFile.has(path)) byFile.set(path, []);
      continue;
    }
    if (line.startsWith('--- ')) continue; // old-file header — ignore

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = parseInt(hunk[1]!, 10); continue; }

    if (path === null) continue; // outside a recognised file body (e.g. /dev/null target)

    if (line.startsWith('+')) {
      byFile.get(path)!.push({ newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      // removed line — does not advance the new-file counter
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, no counter change
    } else {
      newLine++; // context line
    }
  }
  return byFile;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

// Resolve a finding to an added line number in the diff, or null if it can't be placed
// inline. `prefix` is the project dir relative to the repo root (e.g. "analytics/") for
// monorepos where the dbt project isn't at the repo root; findings are project-relative,
// the diff is repo-relative.
//
// Tiered match against the file's added lines: exact normalized equality, then substring
// either direction, then a token-overlap majority. Descriptive evidence ("filename: X")
// won't match any source line and returns null → handled by the summary fallback.
export function matchFindingToLine(
  finding: Finding,
  diff: Map<string, AddedLine[]>,
  prefix = '',
): number | null {
  const repoPath = prefix ? `${prefix.replace(/\/$/, '')}/${finding.file}` : finding.file;
  const added = diff.get(repoPath);
  if (!added || added.length === 0) return null;

  const ev = normalize(finding.evidence);
  if (!ev) return null;

  // Tier 1: exact line match.
  for (const a of added) if (normalize(a.text) === ev) return a.newLine;
  // Tier 2: substring either direction (evidence is a fragment of the line, or vice versa).
  for (const a of added) {
    const t = normalize(a.text);
    if (t.includes(ev) || ev.includes(t)) return a.newLine;
  }
  // Tier 3: token-overlap majority — tolerates minor reformatting.
  const evTokens = new Set(ev.split(' ').filter(Boolean));
  if (evTokens.size === 0) return null;
  let best: { line: number; overlap: number } | null = null;
  for (const a of added) {
    const aTokens = a.text.trim().split(/\s+/).filter(Boolean);
    if (aTokens.length === 0) continue;
    const hits = aTokens.filter(t => evTokens.has(t)).length;
    const overlap = hits / Math.max(aTokens.length, evTokens.size);
    if (overlap > (best?.overlap ?? 0)) best = { line: a.newLine, overlap };
  }
  return best && best.overlap >= 0.6 ? best.line : null;
}

function commentBody(f: Finding): string {
  return `**${f.severity}** · ${f.rule}\n\n${f.suggested_fix}`;
}

function summaryLine(f: Finding): string {
  return `- **${f.severity}** · ${f.rule} · \`${f.file}\` — ${f.evidence} → ${f.suggested_fix}`;
}

// Build the batched-review payload: findings that map to a diff line become inline
// comments; the rest are grouped by severity into the review summary `body`. Every
// finding lands somewhere. Severity order: blocker → major → minor.
export function buildReviewPayload(findings: Findings, diff: Map<string, AddedLine[]>, prefix = ''): ReviewPayload {
  const sorted = [...findings.findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const comments: ReviewComment[] = [];
  const unmapped: Finding[] = [];

  for (const f of sorted) {
    const line = matchFindingToLine(f, diff, prefix);
    const repoPath = prefix ? `${prefix.replace(/\/$/, '')}/${f.file}` : f.file;
    if (line !== null) comments.push({ path: repoPath, line, side: 'RIGHT', body: commentBody(f) });
    else unmapped.push(f);
  }

  const head = `## bk1 dbt review — ${findings.project_name}\n\nHealth score: ${findings.health_score}/100 · ${findings.findings.length} finding${findings.findings.length === 1 ? '' : 's'} (${comments.length} inline)`;
  const body = unmapped.length
    ? `${head}\n\n### Findings not on changed lines\n\n${unmapped.map(summaryLine).join('\n')}`
    : `${head}\n\nAll findings are attached inline.`;

  return { body, comments };
}
