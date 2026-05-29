import { existsSync } from 'fs';
import { join } from 'path';
import { bk1AssetsDir } from './bk1-home';

// Holds the bk1-lint binary + bundled kimball DB. Skill prompts substitute this
// into the binary_path argument they tell the LLM to call lint_run with.
const SKILL_DIR = bk1AssetsDir();

// /kimball is satisfied entirely by the bundled SQLite DB — no markdown needed at runtime.
// Detect the DB at either the installed location (deployed by scripts/install.sh) or the
// repo-relative dev path (when running via `bun src/app.tsx`). The skill prompt uses this
// solely to decide between "library available, use kimball_query" and "library missing,
// fall back to general Kimball knowledge."
function resolveKimballDbPath(): string | null {
  const installed = join(SKILL_DIR, 'kimball/kimball.db');
  if (existsSync(installed)) return installed;
  const dev = join(import.meta.dir, '..', 'skills_data/kimball/kimball.db');
  if (existsSync(dev)) return dev;
  return null;
}
const KIMBALL_DB = resolveKimballDbPath();

export interface Skill {
  description: string;
  usage: string;
  expand: (args: string) => string;
}

export const SKILLS: Record<string, Skill> = {

  investigate: {
    description: 'Triage failed models from the last dbt run',
    usage: '/investigate',
    expand: () => `Investigate failed dbt models from the last run.

1. Call query_run_results with query="summary". Do NOT use read_file on run_results.json — the file can be 50K+ tokens. If the tool reports the file is missing, relay that and stop (do not run dbt automatically).
2. Print one line:
     Run from <generated_at> — <total> results — <counts as "status: n, status: n"> — elapsed <elapsed_time>s
3. If counts.failures and counts.skipped are both 0 (no error/fail/skipped statuses), print:
     "Run is clean — no failures to investigate."
   and stop. Do not call any other tools.
4. Otherwise call query_run_results with query="failures" to get full diagnostic info for the failed models. If the summary listed skipped models, also call query_run_results with query="skipped" for the collateral list. Skipped items are NEVER root causes — list them separately.
5. For each failed model (not skipped) do exactly these calls — do not use list_files, bash find, or read other models:
   a. Call query_manifest with query="model", model="<failed_model_name>". The returned path, compiled_path, parents, children replace any need to discover paths.
   b. Quote the message field from the step-4 failures result.
   c. Call read_file with the path field from 5a (model SQL).
   d. Call read_file with the compiled_path field from 5a (if read_file returns "File not found", skip and note compiled SQL was unavailable).
   e. Run bash: git log -5 --oneline -- <path from 5a>
   f. Check the parents list from 5a — if any parent name is in the step-4 failures list, this is an upstream cascade (no further investigation needed for this model).
   g. Classify root cause as one of: Schema/contract drift, SQL syntax/dialect, Permission/object missing, Incremental logic, Jinja/compilation, Data issue, Test failure, Upstream cascade. If unclear, say "needs investigation" and state what signal is missing.
6. Produce a consolidated report:
   - Number of failures, tests failed, skipped collateral
   - For each failure: error quote, file path, diagnosis, proposed fix, risk level (low/medium/high)
   - A numbered fix plan in dependency order (parents first)
7. End with: "Reply apply to execute these fixes, or tell me which to change or skip."
   Then stop and wait for approval before editing any files.`,
  },

  explain: {
    description: 'Explain a model — purpose, lineage, columns, SQL walkthrough',
    usage: '/explain <model_name>',
    expand: (args) => {
      if (!args) return `Ask the user: "Which model should I explain?"`;
      return `Explain the dbt model "${args}".

1. Call query_manifest with query="model", model="${args}". Use the returned path, yaml_path, compiled_path, materialized, schema, tags, parents, children.

2. Read exactly these three files using read_file: path, yaml_path, compiled_path. Do not read parent or child models — their names are sufficient context.

3. Run exactly one bash call: git log -5 --oneline -- <path from step 1>

Then produce the explanation:

  Model: ${args}
  Purpose — what the model does based on the YAML description and the SQL. If they disagree, say so.
  Materialization — table/view/incremental/snapshot/ephemeral plus key configs from the manifest profile.
  Lineage
    Parents: <list from step 1>
    Children: <list from step 1, or "none found">
  Columns — name, type if known, description, tests (from the YAML)
  SQL walkthrough — CTE by CTE explanation in plain English. Highlight non-obvious logic, window functions, filters, joins.
  Recent changes — summarise the git log output in one or two sentences.
  Notable observations — missing tests, undocumented columns, unusual patterns. Only flag things actually worth flagging.`;
    },
  },

  docs: {
    description: 'Generate or update YAML documentation for a model',
    usage: '/docs <model_name>',
    expand: (args) => {
      if (!args) return `Ask the user: "Which model should I document?"`;
      return `Generate or update YAML documentation for the dbt model "${args}". Exactly 4 tool calls before producing the proposal.

1. Call query_manifest with query="model", model="${args}".

2. read_file the path field (model SQL).

3. read_file the yaml_path field. The entry for "${args}" is the only one in that file (one model per YAML by convention) — do not search elsewhere.

4. read_file the compiled_path field to confirm column names. If missing, say "compiled SQL not available — column list inferred from source SQL only" and continue.

Then build a draft YAML block:
- Write a meaningful model description based on what the SQL actually does.
- List every column with a description inferred from the name and usage.
- Add tests conservatively:
  - not_null for primary keys, foreign keys, and columns that must be present.
  - unique for the grain/primary key column.
  - accepted_values for low-cardinality enums you can identify with confidence.
  - relationships for foreign keys to other dbt models where the parent model is clearly identifiable.
  - Do not invent tests just in case.
- Use the | block scalar for multi-line descriptions.
- Each YAML file must contain exactly one model.

Present the proposed YAML clearly, including:
- Target file path (existing or new)
- Whether you are creating a new file or updating an existing entry
- Any columns you are uncertain about and why

End with: "Reply apply to write this YAML."
Then stop and wait for explicit approval before writing anything.`;
    },
  },

  kimball: {
    description: 'Kimball dimensional modeling consultant — Lookup, Review, or Consult modes.',
    usage: '/kimball <question or "review <model>">',
    expand: (args) => {
      const hasLibrary = KIMBALL_DB !== null;

      if (!args) {
        return `Print this help text verbatim and stop. Do NOT read any files.

Kimball skill — help

I'm a Kimball dimensional modeling consultant grounded in The Data Warehouse Toolkit (3rd Edition). Three modes, picked automatically from how you ask:

  Lookup    factual recall          /kimball what is a semi-additive fact?
  Review    audit an existing model /kimball review models/marts/fct_invoices.sql
  Consult   design recommendation   /kimball how should I model order-to-cash?

${hasLibrary
  ? `Library bundled with bk1, indexed in SQLite + FTS5 at ${KIMBALL_DB} — 21 chapter summaries available for citation.`
  : `Library not found. The bundled knowledge base DB is missing — re-run "bun run setup" to install it.`}`;
      }

      const libBlock = hasLibrary
        ? `Kimball library is bundled with bk1 and indexed in SQLite + FTS5. Use the kimball_query tool — NEVER bash cat / grep the raw markdown (that wastes 3-5× more tokens than the structured query).

kimball_query modes:
  mode="concept", q="<term>"        Lookup a Kimball term. Returns definition + chapters that define it + section hints. Use this FIRST for any "what is X?" question.
  mode="search",  q="<query>", limit=5
                                    FTS5 over section content. Returns ranked excerpts (~1-2KB total). Use for fuzzy questions where you don't know the exact term.
  mode="section", chapter=N, section="<heading match>"
                                    Retrieve one chapter section by chapter+heading. Returns full content of matching sections. Use after concept/search points you at the right place.
  mode="chapter", chapter=N         Chapter table of contents (heading list only, ~500 tokens). Use when you need to know what's in a chapter before drilling in.

The four-mode pattern always: cheap concept/search call → identify the relevant section → section mode for full content. Do NOT chapter-dump unless absolutely necessary.`
        : `Kimball library is not bundled with this bk1 install. Answer from general Kimball knowledge but DO NOT fabricate chapter/section citations. Tell the user once: "Library not bundled — recommendations below are from general Kimball knowledge without chapter citations. Run 'bun run setup' to install the bundled library." Then proceed.`;

      return `Handle the Kimball question: "${args}". You are a consultant, not a search engine — understand the situation, ask if you need to, and deliver an opinionated recommendation. Citations support your judgment; they do not replace it.

${libBlock}

## Step 0 — Classify the question

| Mode | Trigger | Goal |
|---|---|---|
| Lookup | "What is X?", "Define Y", "List Z" — factual recall | Definition + citation + when to use vs alternatives |
| Review | User references an existing artifact — file path, SQL, "review this", "is X correctly modeled", "what shape is this table?" | Evaluate against Kimball principles; produce findings or a shape classification |
| Consult | User describes a situation with no artifact yet — "how should I model X?", "should I use A or B for our case?" | Ask 2–5 clarifying questions, then recommend |

Naming is NEVER classification. "Is fct_orders a fact?" — read the SQL, inspect grain and row semantics. The prefix is a convention, not evidence. Same applies to stg_, dim_, int_.

If ambiguous, ask which mode — don't guess.

## LOOKUP workflow
1. ${hasLibrary ? `kimball_query mode="concept", q="<term>". This returns the definition snippet + list of defining chapters with section hints — typically all the citation info you need.` : 'Identify the relevant Kimball topic from general knowledge'}
2. ${hasLibrary ? `If the concept hit has a section_hint that exactly matches what the user is asking, call kimball_query mode="section", chapter=<num>, section="<hint>" for full prose. Skip this step if the concept response already gave a sufficient definition.` : 'Recall the concept'}
3. Answer in this shape:
   - One-paragraph definition in Kimball's terms
   - Citation (chapter + section)${hasLibrary ? '' : ' — omit if library not installed'}
   - When you'd use it vs 1–2 nearby alternatives
   - Optional: 1–2 short worked examples

## REVIEW workflow
Read the artifact FIRST, then evaluate. Do not ask clarifying questions before reading — the model answers most of them.

1. Call query_manifest query="model", model="<name>" — returns path, yaml_path, parents, children in one ~500-token response.
2. read_file the path (model SQL) and yaml_path (YAML).
3. For each parent in result.parents (immediate upstream), call query_manifest model="<parent>" and read its files. Conformance and grain are upstream concerns.
4. Classify shape from the SQL — never from the filename prefix:
   - Transaction fact (one row per business event with timestamp + measures + FKs)
   - Periodic snapshot fact (one row per entity per time bucket)
   - Accumulating snapshot fact (one row per pipeline instance with milestone date FKs that update)
   - Factless fact (event tracking, no measures)
   - SCD1 dim (one row per entity, overwritten on change)
   - SCD2 dim (one row per entity-version with valid_from/valid_to/is_current)
   - Bridge (composite key linking two entities, optional weighting)
   - Junk dim (cross-product of low-cardinality flags)
   - Staging passthrough (cleaned/renamed source — NOT a Kimball object)
   - OBT / unclear (mixed grains, fact+dim columns combined)
5. ${hasLibrary ? `kimball_query mode="chapter", chapter=11 to see Ch 11's table of contents — the design-review spine. Then kimball_query mode="section", chapter=11, section="<heading>" for the sections that match the classification (granularity, conformity, surrogate keys, etc.). Do EVERY review.` : 'Apply Ch 11 (design review checklist) principles from memory.'}
6. Pull 1–2 supporting chapters by classification (kimball_query mode="section" or mode="search"):
   - SCD dim → Ch 5
   - Fact → Ch 3 (grain) + Ch 4 (fact type)
   - Customer/employee/bridges → Ch 7, 8, or 9
   - Multi-currency / role-playing / junk → Ch 6 or Ch 12
7. Score findings:
   - CRITICAL — violates fundamental Kimball; numbers will be wrong or unmaintainable. Examples: mixed grain in one fact, fact joined to fact, missing FK to existing conformed dim, semi-additive fact summed across time, no declared grain, SCD1 used where history is required.
   - MODERATE — sub-optimal; works today but creates friction. Examples: snowflaked dim that should be flat, missing surrogate key, no junk dim for low-cardinality flags, role-playing dim not aliased, outrigger that should be denormalized, missing relationships test.
   - MINOR — convention/polish. Examples: missing fct_/dim_ prefix, missing yml description, missing unique test on grain key.
8. Output per finding: "[Severity] Short label" + what's wrong (point at specific column/line) + Kimball rule violated (+ citation if library installed) + suggested fix in dbt terms (table below).
9. Overall verdict: PASS / PASS WITH CHANGES / REDESIGN NEEDED. If >3 findings, name the 1–2 highest-leverage fixes.

### Sub-mode: Classify shape
When the user asks "is <model> a fact / dimension / <Kimball object>?" — answer with shape classification, not a full review. Output:

  Shape: <Kimball pattern>
  Grain: one row per <...>
  Evidence:
    - <signal from SQL/columns>
    - <signal>
  Why not <nearest alternative>: <one sentence>
  Caveats/smells: <anything ambiguous or "none">

If it doesn't fit cleanly, say so plainly ("this is a staging passthrough, not a Kimball object" / "OBT mixing event measures with entity attributes — neither a clean fact nor dim") and name what would need to change. Don't force a label.

## CONSULT workflow
A consultant doesn't recommend before they understand. Ask FIRST, read chapters SECOND.

### Ask 2–5 clarifying questions before reading any chapter
Pick whichever are load-bearing for the decision. Group into one response, don't drip:
- Business process & grain — what business event? Atomic unit (one row per ___)?
- Source shape — transactional, state-snapshot, or both?
- Query patterns — point-in-time, trends, drill-across, ad-hoc/canned?
- Update cadence — real-time, daily, monthly; late-arriving facts; restatements?
- Scale — rows/day, dim cardinality, retention window
- Existing landscape — what conformed dims/facts already exist? Bus matrix rows in place?
- Consumers — BI tool, OLAP cube, direct SQL, ML?

By design area:
- SCD: do users need history? "as-it-was-then" vs "as-it-is-now" vs both? Change frequency?
- Fact type: definite pipeline start/end (→ accumulating)? Point-in-time balances (→ periodic)? Pure event stream (→ transaction)?
- Bridge: how many values per fact row? Natural weighting (allocation %, primary diagnosis)?

If the user's first message already answers some, acknowledge what you have and ask only for the gaps.

### After user answers
- Synthesize across 3–4 chapters, not 1. Typical: Ch 3 (grain) + Ch 4 (fact type) + Ch 5 (SCD) + bridge/hier from Ch 7/8/9.
- ${hasLibrary ? `Use kimball_query mode="section" on the specific sections you need from each chapter — do NOT pull whole chapters. The quick map below tells you which chapter; the heading_path tells you which section.` : 'Apply principles from general Kimball knowledge'}.
- Form a judgment. Pick THE answer for this user's situation, with trade-offs.

### Consult response shape
1. Recommendation — concrete: grain, fact type, dim list, SCD types per attribute, bridges/outriggers. Lead with this in ≤2 sentences.
2. Why this fits — connect their answers to the chosen pattern. "Because you said X and need Y, the right call is Z."
3. Trade-offs — 1–2 plausible alternatives + when each would be preferred. Be honest if it's close.
4. Risks — what will hurt them later (late-arriving dims, reprocessing if grain is wrong, conformance drift).
5. Citations — at the end, supporting the call. Not at the front.${hasLibrary ? '' : ' Omit if library not installed.'}
6. Suggested next reads — 1–2 specific summary files.${hasLibrary ? '' : ' Omit if library not installed.'}

## dbt mapping (Kimball pattern → dbt mechanism)
| Pattern | dbt mechanism |
|---|---|
| SCD Type 1 | materialized='table', overwrite on each run |
| SCD Type 2 | snapshots/ block (strategy='timestamp' or 'check'); or hand-modeled valid_from/valid_to/is_current |
| Surrogate keys | dbt_utils.generate_surrogate_key([nat_key, effective_date]) |
| Grain enforcement | unique + not_null tests on grain column(s); optionally model contracts |
| Referential integrity (FK → dim) | relationships test in yml pointing at the dim |
| Conformed dimension | One dim_* model ref'd by every mart; never re-derived per mart |
| Fact table load | materialized='incremental', unique_key=grain, on_schema_change='fail' |
| Late-arriving dim | coalesce(dim_sk, unknown_member_sk) in fact; explicit "unknown" row in dim |
| Junk dim | Table from cross join of flag domains (or distinct observed combos); single FK on fact |
| Role-playing dim | Multiple ref()s aliased differently (order_date, ship_date); or views over the canonical dim |
| Bridge table | Separate model with composite key + (optional) weighting; joined explicitly |
| Degenerate dim | Plain column on the fact — no separate model, no FK |

## Concept-to-chapter quick map
Dim fundamentals: 1, 2, 3 · Three fact types: 4 (defs); 3, 6, 13, 14, 16 (examples) · 8 SCD types: 5; 19 subsystem 9 · Conformed dims, bus matrix: 4 · Role-playing, junk, header/line, multi-currency: 6 · Ragged hierarchies, budget chain: 7 · Customer dim, bridges, behavior groups, timespan facts: 8 · Bridges for skills, recursive hierarchies, surveys: 9 · Account-to-customer bridges, mini-dims, dynamic value bands: 10 · Design review checklist: 11 · Multiple grains, combined role-playing, time zones: 12 · Accumulating snapshots, factless: 13 · Healthcare claims, multivalued, measure type: 14 · Clickstream + web profitability: 15 · Case study + top 10 mistakes: 16 · Lifecycle: 17 · Modeling process: 18 · 34 ETL subsystems: 19 · ETL dev process + real-time: 20 · Big data, Hadoop, data highway: 21

## Hard rules
- Don't paraphrase from training data when the library is installed — consult the files. They are authoritative for "what Kimball says."
- Don't invent "Kimball says X" for techniques not in the chapters. If not covered, say so.
- Don't read chapter.md by default — summaries usually answer.
- Don't load all summaries upfront — pick from the quick map.
- Don't recommend before clarifying (consult mode). Don't ask clarifying questions before reading the artifact (review mode).
- Don't lead with citations — lead with the recommendation or finding.
- Don't pick the "safest" pattern to avoid taking a position. That's hedging, not consulting.
- Push back when warranted: mixed grain, fact-to-fact joins, accumulating-snapshot treated as transactional, SCD-type conflations. Name the issue with citation.`;
    },
  },

  impact: {
    description: 'Blast-radius analysis — downstream graph, tests at risk, optional column lineage',
    usage: '/impact <model[.column]> | +<model> | <model>+',
    expand: (args) => {
      if (!args) return `Ask the user: "Which model should I run impact analysis on? Use selector syntax: model_name (downstream), +model_name (upstream), +model_name+ (both), or model_name.column_name for column-level lineage."`;
      return `Run impact analysis for "${args}". Parse the selector first — no preamble, begin output with step results.

## Step 1 — Parse the selector

Strip whitespace. Determine direction and target:
- Leading "+" only (e.g. "+stg_orders") → direction="upstream", model = the rest with "+" trimmed
- Trailing "+" only (e.g. "stg_orders+") → direction="downstream", model = the rest with "+" trimmed
- Both "+" (e.g. "+stg_orders+") → direction="both", model = the rest with both "+" trimmed
- No "+" (e.g. "stg_orders") → direction="downstream" (default), model = the input
- A "." in the model part (e.g. "stg_orders.customer_id") → split on "." once; left is the model, right is the column for column-level lineage. Direction is determined by the "+" markers (or default downstream).

If the column selector is present but direction is "upstream", tell the user "column-level lineage only flows downstream — drop the column or change direction" and stop.

## Step 2 — Call query_manifest

Single call: query_manifest with query="impact", model=<parsed model>, direction=<parsed direction>, and column=<parsed column if any>.

If the result says "not found in manifest", stop.

If the response has direction="downstream" or "both" and downstream is empty, this is a leaf model — print "Leaf model — nothing downstream. Safe to change at the data layer; check non-ref references manually." and continue to Step 4 anyway (skip the graph section).

## Step 3 — Render the impact report

  Impact analysis — <model.name>
  Materialization: <materialized> · Schema: <layer> · Tests on this model: <model.tests.length>
  Downstream: <downstream.length> models · Max depth: <max_depth>
  (if upstream present) Upstream: <upstream.length> models

  Downstream graph
  Render as an ASCII tree IF downstream.length <= 25, sorted by depth then name. Use box-drawing chars (├──, └──, │). Show each node as "<name> (<materialized>)". Indent children by depth.

  When downstream.length > 25, switch to a flat list grouped by layer:
    intermediate (<count>)
      - <name> (<materialized>, depth <d>)
    marts (<count>)
      - <name> (<materialized>, depth <d>)
    presentation (<count>)
      - <name> (<materialized>, depth <d>)

  By layer
  Render a compact one-liner from by_layer: e.g. "intermediate: 2   marts: 3   presentation: 1"

  Tests at risk
  Collect tests from model.tests + every descendant's tests. Group by model:
    <model.name> (target): <test1>, <test2>
    <descendant>: <test>, <test>
  If 0 tests total, print "No tests defined on this model or its descendants."

  (only if "upstream" present)
  Upstream sources
  Render upstream models in flat list, depth ascending, grouped by layer. These are what the target depends on — useful for "why is this column null?" debugging.

## Step 4 — Column lineage (only if column was set and result has column field)

  Column lineage — <column.name>
  Render this section using column.taint (Record<model, [cols]>) and column.trace_status (Record<model, {status, reason?, partialReasons?}>).

  Sort descendants by depth. For each descendant in downstream:
    <model_name> (depth <d>):
      derived columns: <list from column.taint[model_name] or "none">
      trace status: <traced | sql_missing | parse_failed | partial>
      (if status !== "traced") reason: <status.reason or summary of partialReasons>

  Then summarise:
    Total descendants with tainted columns: <count where taint is non-empty>
    Models where trace failed: <list with reasons>
    Models with partial trace: <count>

  Important footnote: v1 lineage handles named columns, CTE aliases, qualified JOINs, cast/coalesce, and UNION ALL. Window functions, aggregations with GROUP BY, complex CASE, and select * over raw tables surface as "partial" — re-read the model's compiled SQL manually for those.

## Step 5 — Non-ref references

Run exactly one bash call to find references that bypass ref():
  grep -rn "${args.split('.')[0]!.replace(/^\\+|\\+$/g, '')}" macros/ analyses/ seeds/ 2>/dev/null | head -20

If results: "Non-ref references found (will NOT auto-update on rename):" and list each match with file:line.
If none / "No such file": skip the section (don't print empty headers).

## Step 6 — Risk callouts

Print a "Risk callouts" section with synthesised assessments. Examples — only include when the condition actually applies:
- "HIGH: <N> marts and <M> presentation models downstream — column renames require test updates and may break BI reports." (when by_layer.marts + by_layer.presentation > 0)
- "MEDIUM: dim_ model downstream with SCD type — confirm SCD impact." (look at descendant names matching /^dim_/)
- "HIGH: incremental model downstream — column changes may require a full-refresh." (when any descendant.materialized === "incremental")
- "LOW: All downstream is intermediate-only — confined to mid-pipeline." (when by_layer has only intermediate)

## Step 7 — Suggested next steps

  Suggested next steps
  - /explain <one of the downstream models> — understand a specific dependent before changing
  - /refactor ${args.split('.')[0]!.replace(/^\\+|\\+$/g, '')} — rewrite the source model (does not propagate)
  - (if column was set) Re-run /impact ${args.split('.')[0]!.replace(/^\\+|\\+$/g, '')}.<another_column>+ to check other columns

Do not suggest /refactor as an auto-trigger — it is a separate explicit command for the user to run.

End. No file edits. Pure information.`;
    },
  },

  refactor: {
    description: 'Refactor a model to dbt style and fix raw table references',
    usage: '/refactor <model_name>',
    expand: (args) => {
      if (!args) return `Ask the user: "Which model should I refactor?"`;
      return `Refactor the dbt model "${args}" to dbt style. Preserve behavior exactly — no new joins, no dropped columns, no changed filters. Exactly 3 tool calls before producing the proposal.

1. Call query_manifest with query="model", model="${args}".

2. read_file the path field. Do not read other models.

3. Call query_manifest with query="refs" — returns {models: [name…], sources: [{source, table}…]}. Do NOT call query="models" or query="sources" — refs is ~10× smaller and covers both.

Reference rewiring — scan every FROM and JOIN clause in the SQL for anything that is not already ref() or source():
- If it matches a name in refs.models: replace with {{ ref('model_name') }}
- If it matches an entry in refs.sources (by table name, with source disambiguation when possible): replace with {{ source('source_name', 'table_name') }}
- If no match: leave as-is and add a comment: -- TODO(dbt-refactor): no dbt model/source found for <original_ref>
- If a table name appears in multiple sources: list the candidates and ask which to use.

Style formatting to apply:
- Lowercase all SQL keywords and built-in functions.
- Convert inline subqueries to named CTEs. Use a "final" CTE as the last step; end with "select * from final".
- First CTEs alias each ref()/source() as import CTEs.
- One column per line with leading commas.
- Two-space indent inside CTEs and select lists.
- Explicit join types (inner join, left join — never bare join).
- Qualify columns in joins.
- One blank line between CTEs.
- Keep the {{ config(...) }} block at the very top if present.

Before presenting the plan, verify behavior is preserved:
- Same columns in the final select (names, order, expressions).
- Same where/having filters, join keys and types, group by/order by/limit.

Present the plan with:
- A reference rewiring table showing original → new for each change
- A list of style changes applied
- Confirmation that behavior is preserved (or call out any exception)
- The full proposed SQL

End with: "Reply apply to write the refactored model."
Then stop and wait for explicit approval before writing anything.`;
    },
  },

  lint: {
    description: 'Mechanical lint scan + summary (no fixes, no semantic checks)',
    usage: '/lint [--full]',
    expand: (args) => {
      const forceFlag = args.includes('--full') || args.includes('full') ? '--no-cache' : '';
      return `Run the mechanical lint pass. No preamble — begin output directly with step results.

Hard rules: no file edits, no dbt build/run, never modify CLAUDE.md.

## Step 1 — Verify project root
Check dbt_project.yml exists in the current directory. If absent, say so and stop. If found, continue silently.

## Step 2 — Scan and queue${forceFlag ? `

Call model_state action="reset" to mark all models as needs_recheck.
Print: "Full re-lint forced — all models queued."
` : ''}
Call model_state with action="lint_run", binary_path="${SKILL_DIR}/bk1-lint"${forceFlag ? `, force=true` : ''}.
Handles sync + queue + mechanical scan + violation filtering in one call.

If result.error === "binary_not_found": print result.message verbatim and stop.
If result.nothing_to_lint === true: print "Nothing to lint — all models are up to date." and stop.

Otherwise print:
  "State: <sync.total> total — <sync.added> new, <sync.changed> changed, <sync.unchanged> unchanged."
  "Batch: <batch.size> model(s) — <batch.remaining> remaining in queue."
If batch.remaining > 0, also print: "Re-run /lint after this batch to continue."

## Step 3 — Summary table
Using violations.project_by_rule and violations.project_total (project-wide totals, not batch-scoped), print exactly:

  <project_name> · <project_total> violations · <batch.size> files queued

  | **severity** | **rule** | **description** | **count** |
  |--------------|----------|-----------------|----------:|
  | major | <code> | <rule> | <N> |
  | minor | <code> | <rule> | <N> |

Sort: major first, then minor, each group by count desc. Use the short code field (e.g. mart_naming, staging_cast) for the "rule" column, and the longer "rule" text from each project_by_rule entry for the "description" column.

After the table, print the clickable report line (the tool returns the absolute path in result.report_path):
  "Report: <report_path>"

End with this line and stop:
  "Reply /lint-deep to run semantic checks and apply fixes, or /lint --full to force a full re-scan."`;
    },
  },

  'lint-deep': {
    description: 'Semantic checks, health score, and apply mechanical fixes (run after /lint)',
    usage: '/lint-deep',
    expand: () => `Continue the lint workflow with semantic checks, scoring, and fix application. No preamble.

Prerequisites: /lint was just run. Re-use the most recent lint_run result from prior conversation history. If unavailable, call model_state action="lint_run", binary_path="${SKILL_DIR}/bk1-lint" first — the incremental cache makes this nearly free.

Hard rules: no file edits before explicit user approval, no dbt build/run, never modify CLAUDE.md, never delete a model file (rename/move/edit only).

## Step 1 — Filter the semantic queue

Build the batch file set: every .sql and .yml path for models in batch.models (e.g. "stg_orders" → models/staging/stg_orders.sql + .yml).

Intersect the lint_run result's semantic_review_queue (sibling of violations on the response) with the batch file set. Discard paths NOT in the batch — the lint binary scans the full project but only the current batch should be checked semantically.

Derive per-rule lists from the filtered queue:
- Rule A → every .yml file
- Rule C → paths starting with "models/staging/" ending in ".sql"

Skip a rule if its list is empty.

## Step 2 — Spawn sub-agents in parallel

Call the agent tool once per rule in a SINGLE response. Set description= to the short label.

Sub-agent prompt template (fill in RULE, FILE LIST, PROJECTION):
---
You are a dbt code reviewer checking one specific rule.

Rule: <RULE>

Files to review:
<FILE LIST — one path per line>

Instructions:
- Call model_state action="fetch_content", paths=[<JSON array>], projection="<PROJECTION>" as your FIRST and ONLY tool call. The projection returns a rule-specific slim view, not raw content. Do NOT use read_file. Do NOT call fetch_content without the projection.
- Each file in the result is delimited by: === <path> ===
- Check ONLY this rule. "select * from final" and "select * from renamed" are NEVER violations — the column list is explicit in the CTE above. Only flag select * inside transformation CTEs, or when the entire model is a bare "select * from {{ ref(...) }}".
- Return ONLY a JSON array (no narration, no fences): [{"file": "<path>", "severity": "major|minor|ambiguous", "evidence": "<excerpt>", "suggested_fix": "<change>"}]
- Return [] if no violations.
---

Rule → label → projection:
  A → "Semantic: description quality" → projection="descriptions"
  C → "Semantic: staging joins" → projection="sql_compact"

Rule text (verbatim):
  A: Model and column descriptions must be meaningful and non-trivial. Flag vague descriptions (e.g. "This model contains data", "TODO", single-word, restatement of the model name). Severity: major if model description is trivial, minor if column description is trivial.
  C: Staging models must not contain heavy joins or transformations. Flag JOIN clauses, GROUP BY, window functions, or complex CASE beyond simple renaming and type casting. Severity: major.

Parse each result. Malformed → treat as [] and note rule unchecked. Add "check_type": "semantic" to each finding. Merge with mechanical violations.

## Step 3 — Health score

total_rule_checks = number of (rule × applicable file) pairs evaluated
weighted_penalty  = (3 × blockers) + (2 × majors) + (1 × minors)
max_penalty       = 3 × total_rule_checks
health_score      = round(100 × (1 − weighted_penalty / max_penalty))

Ambiguous findings excluded. Clamp [0, 100]. total_rule_checks == 0 → n/a.

Buckets: 90+ Healthy, 75–89 Mostly healthy, 50–74 Needs attention, <50 Significant non-compliance.

## Step 4 — Consolidated report

  dbt Project Health Check — <project_name>
  Generated: <timestamp>
  Health Score: <score>/100 — <bucket>
  Blockers: <N>   Major: <N>   Minor: <N>   Ambiguous: <N>

  FINDINGS
  Blockers / Major / Minor — for each: <rule> — <path>, Evidence: <excerpt>, Fix: <change>
  Ambiguous — <rule> — <why ambiguous>

  RECOMMENDATIONS (highest-leverage first)

  AUTO-FIXABLE vs MANUAL

Render this as a markdown table with exactly three columns and these exact rows. Use the pipe alignment shown so the columns line up when the terminal renders the table — do not improvise spacing or omit empty cells.

  | **Finding type** | **Auto-fixable** | **Needs human** |
  |------------------|------------------|-----------------|
  | YAML block scalar (> to \\|) | yes | |
  | Filename rename | yes | |
  | Missing YAML scaffolding | yes (TODO desc) | |
  | Wrong folder placement | yes | |
  | Column ordering in final select | yes | |
  | Bare select * with no CTE | no | yes — enumerate columns |
  | Missing SCD type annotation | no | yes — confirm SCD type |
  | Trivial descriptions | no | yes — write real desc |
  | Ambiguous findings | no | yes |

Only include rows for finding types that actually appear in this run's results. Drop rows that have no matching findings.

After the table, print the clickable report line (the lint_run result returns the absolute path in result.report_path):
  "Report: <report_path>"

End with: "Reply 'apply all auto-fixable' to fix everything, 'apply <numbers>' for specific items, or 'skip'."
Stop and wait for explicit approval.

## Step 5 — Apply approved fixes

Order to minimise churn:
  1. YAML edits (descriptions, block scalar, column order, SCD annotations)
  2. SQL formatting
  3. File renames/moves — after each rename, grep for every ref('<old_name>') across models/, tests/, analyses/, seeds/, macros/ and update before moving on
  4. New YAML scaffolding for undocumented models — "TODO: describe <model_name>", description "TODO" per column. Flag in post-fix summary.

After all fixes: dbt parse (confirms Jinja and refs resolve — do not run dbt build).

Record results for every batch model. For each, call model_state action="mark_linted":
  - model_name, lint_status ("clean" | "violations"), violation_count, violations_json

## Step 6 — Re-run and show delta

Re-run binary: ${SKILL_DIR}/bk1-lint . --no-cache
Recompute score and print:
  "Post-fix re-run — <project_name>"
  "Previous: <old>/100 → New: <new>/100 (Δ <signed>)"
  Full report as in Step 4.

If new score < 90 with remaining auto-fixable findings, offer another approval round. Otherwise stop and summarise human-only follow-up.`,
  },

  plan: {
    description: 'Plan mode — agent outlines a plan and waits for approval before any tool call',
    usage: '/plan',
    expand: () => '',
  },

  build: {
    description: 'Build mode (default) — agent edits files and runs dbt with confirmation on destructive ops',
    usage: '/build',
    expand: () => '',
  },

  auto: {
    description: 'Auto mode — agent applies mechanical lint fixes without confirmation prompts',
    usage: '/auto',
    expand: () => '',
  },

  model: {
    description: 'Switch model: haiku · sonnet · opus',
    usage: '/model [haiku|sonnet|opus]',
    expand: () => '',
  },

  logout: {
    description: 'Clear the stored API key and return to the login screen',
    usage: '/logout',
    // Intercepted in app.tsx — never reaches expandSkill. Empty expand keeps the
    // contract that every entry has one, and keeps /logout visible in autocomplete + /help.
    expand: () => '',
  },

  usage: {
    description: 'Organization usage + cost (Admin API) and session token breakdown',
    usage: '/usage',
    // Intercepted in app.tsx — fetches org usage via Admin API, no LLM call.
    expand: () => '',
  },

  history: {
    description: 'Write the current conversation to a markdown file and open it in a VS Code editor pane',
    usage: '/history',
    // Intercepted in app.tsx — snapshots messages to <project>/.bk1/session-*.md and shells `code` to open it.
    expand: () => '',
  },

  pet: {
    description: 'Tamagotchi mangrove pet — /pet shows stats, /pet feed|play|sleep|name <name>|playroom|release',
    usage: '/pet [feed|play|sleep|name <name>|playroom <create|join|leave>|release]',
    // Intercepted in app.tsx — all interactions are local state updates.
    expand: () => '',
  },

  help: {
    description: 'Show available slash commands',
    usage: '/help',
    expand: () => {
      const lines = Object.entries(SKILLS)
        .filter(([k]) => k !== 'help')
        .map(([, s]) => `${s.usage} — ${s.description}`)
        .join('\n');
      return `Print the list of available bk1 slash commands exactly as shown, one per line, no extra commentary:\n\n${lines}\n/help — Show available slash commands`;
    },
  },

};

function commandList(): string {
  return Object.values(SKILLS).map(s => s.usage).join(', ');
}

export function expandSkill(input: string): { display: string; prompt: string } | null {
  if (!input.startsWith('/')) return null;

  const [rawCmd, ...argParts] = input.slice(1).split(' ');
  const cmd = rawCmd?.toLowerCase() ?? '';
  const args = argParts.join(' ').trim();
  const skill = SKILLS[cmd];

  if (!skill) {
    return {
      display: input,
      prompt: `The user typed "${input}" but it is not a recognised command. Tell them so and list the available commands: ${commandList()}`,
    };
  }

  return {
    display: input,
    prompt: skill.expand(args),
  };
}
