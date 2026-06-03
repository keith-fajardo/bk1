// bk1-review — headless, review-only entry point. Runs the lint-deep-headless skill
// against a dbt project, then posts the findings as a Copilot-style PR review (inline
// comments where they map to changed lines, summary body for the rest). Never edits files.
//
// This is a SEPARATE binary from the TUI (src/app.tsx) — no Ink, no React. It drives the
// same agent loop (runAgent) that the TUI uses.
//
//   bk1-review --pr <n> --repo <owner/name> --commit <sha> [--fail-on major]
//   bk1-review --json --project-dir <path>     # print findings JSON, no GitHub
//   bk1-review --dry-run --pr <n> --repo <o/r> # print the would-be review, post nothing

import { join, relative, resolve } from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent, rebuildSystemPrompt, type AgentCallbacks } from './agent';
import { expandSkill } from './skills';
import { getStoredKey } from './auth';
import { getProjectDir, setProjectDir } from './project-dir';
import { lintRun } from './state';
import { bk1AssetsDir } from './bk1-home';
import {
  extractFindingsArray,
  parseLintRun,
  computeHealthScore,
  parseUnifiedDiff,
  buildReviewPayload,
  severityRank,
  type Finding,
  type Findings,
} from './review-mapping';
import { fetchPrDiff, postReview, type GhContext } from './github-review';

interface Args {
  pr?: number;
  repo?: string;
  commit?: string;
  json: boolean;
  dryRun: boolean;
  failOn?: string;
  projectDir?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    switch (v) {
      case '--pr':          a.pr = parseInt(argv[++i]!, 10); break;
      case '--repo':        a.repo = argv[++i]; break;
      case '--commit':      a.commit = argv[++i]; break;
      case '--fail-on':     a.failOn = argv[++i]; break;
      case '--project-dir': a.projectDir = argv[++i]; break;
      case '--json':        a.json = true; break;
      case '--dry-run':     a.dryRun = true; break;
      default:
        console.error(`Unknown argument: ${v}`);
        process.exit(2);
    }
  }
  return a;
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(2);
}

// The dbt project dir relative to the repo root (cwd in CI). Empty when the project is at
// the repo root; "analytics" when it's a subdir. Findings are project-relative, the PR
// diff is repo-relative, so this prefix bridges them.
function projectPrefix(): string {
  const rel = relative(process.cwd(), getProjectDir());
  return rel === '' || rel.startsWith('..') ? '' : rel;
}

// Run only the semantic sub-agents over a fixed queue and return their findings. The agent
// is given a constrained prompt (semantic rules only, no lint_run, no file edits) and emits
// a JSON array. Progress goes to stderr so stdout stays clean for --json.
async function runSemantic(queue: string[]): Promise<Finding[]> {
  if (queue.length === 0) return [];
  const skill = expandSkill(`/lint-deep-headless ${queue.join('\n')}`);
  if (!skill) die('lint-deep-headless skill not found');

  const callbacks: AgentCallbacks = {
    onText: () => {},
    onToolStart: (name) => console.error(`· ${name}`),
    onToolEnd: () => {},
  };

  const history: Anthropic.MessageParam[] = [{ role: 'user', content: skill.prompt }];
  const messages = await runAgent(history, callbacks, { mode: 'build', model: 'claude-sonnet-4-6' });

  // Concatenate all assistant text — the fence can land in any turn; extractFindingsArray
  // takes the last fence regardless.
  const allText = messages
    .filter(m => m.role === 'assistant')
    .flatMap(m => (m.content as Anthropic.ContentBlock[]))
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  if (!allText.trim()) die('semantic agent produced no text to parse findings from');
  return extractFindingsArray(allText);
}

// Mechanical findings come straight from the linter (deterministic, no LLM). The agent only
// judges the semantic queue. Findings are merged and scored in code.
async function runReview(): Promise<Findings> {
  const lintJson = await lintRun(join(bk1AssetsDir(), 'bk1-lint'), false);
  const { mechanical, semanticQueue, projectName } = parseLintRun(lintJson);
  console.error(`· lint_run: ${mechanical.length} mechanical finding(s), ${semanticQueue.length} file(s) queued for semantic review`);

  const semantic = await runSemantic(semanticQueue);
  const findings = [...mechanical, ...semantic];

  // rule × file pairs evaluated: mechanical findings each count, plus the semantic queue.
  const ruleChecks = mechanical.length + semanticQueue.length;
  return {
    project_name: projectName,
    health_score: computeHealthScore(findings, ruleChecks),
    generated_at: new Date().toISOString(),
    findings,
  };
}

function failExit(findings: Findings, failOn: string | undefined): void {
  if (!failOn) return;
  const min = severityRank(failOn);
  if (min === 0) die(`--fail-on must be one of: blocker, major, minor (got '${failOn}')`);
  const n = findings.findings.filter(f => severityRank(f.severity) >= min).length;
  if (n > 0) {
    console.error(`Found ${n} finding(s) at or above '${failOn}' severity.`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.failOn && severityRank(args.failOn) === 0) {
    die(`--fail-on must be one of: blocker, major, minor (got '${args.failOn}')`);
  }
  // --project-dir must go through setProjectDir, not just the env var: project-dir.ts
  // resolves its dir at import time, so a later env mutation wouldn't take effect.
  if (args.projectDir) {
    try { setProjectDir(resolve(args.projectDir)); }
    catch (e) { die((e as Error).message); }
    rebuildSystemPrompt();
  }

  const key = process.env.ANTHROPIC_API_KEY ?? getStoredKey();
  if (!key) die('no Anthropic API key (set ANTHROPIC_API_KEY)');
  process.env.ANTHROPIC_API_KEY = key;

  const findings = await runReview();

  // --json: print findings and stop. Useful for piping / local debugging.
  if (args.json) {
    console.log(JSON.stringify(findings, null, 2));
    failExit(findings, args.failOn);
    return;
  }

  // Posting to GitHub requires PR coordinates + a token.
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!args.pr) die('--pr is required to post a review (or use --json)');
  if (!repo) die('--repo or GITHUB_REPOSITORY is required');
  if (!args.commit) die('--commit is required (use the PR head SHA, not the merge commit)');
  if (!args.dryRun && !token) die('GITHUB_TOKEN is required to post (or use --dry-run)');

  const ctx: GhContext = { repo, pr: args.pr, commit: args.commit, token: token ?? '' };
  const prefix = projectPrefix();

  const diff = args.dryRun && !token
    ? new Map()                       // dry-run without a token: nothing maps inline
    : parseUnifiedDiff(await fetchPrDiff(ctx));
  const payload = buildReviewPayload(findings, diff, prefix);

  if (args.dryRun) {
    console.error(`[dry-run] ${payload.comments.length} inline comment(s), summary body:\n`);
    console.log(JSON.stringify(payload, null, 2));
    failExit(findings, args.failOn);
    return;
  }

  await postReview(ctx, payload);
  console.error(`Posted review: ${payload.comments.length} inline, ${findings.findings.length} total finding(s).`);
  failExit(findings, args.failOn);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
