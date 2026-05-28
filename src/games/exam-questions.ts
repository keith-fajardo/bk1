// Hand-curated question bank covering the dbt Analytics Engineering
// Certification topics: refs/sources, materializations, Jinja + macros,
// tests, snapshots, semantic layer, mesh, project structure. Each question
// has exactly one correct answer (index into `options`). Keep questions
// short so they fit on one row with a 5-second timer.
//
// To add a question: append to the array. ExamGame randomly samples 5 each
// session, so larger bank = better replay value.

export interface ExamQuestion {
  question: string;
  options: string[];   // exactly 4 options keeps the UI predictable
  answer: number;      // 0-based index into options
}

export const EXAM_QUESTIONS: ExamQuestion[] = [
  {
    question: 'Which function resolves a reference to another dbt model?',
    options: ['{{ source() }}', '{{ ref() }}', '{{ this }}', '{{ var() }}'],
    answer: 1,
  },
  {
    question: 'Which function references a raw source table?',
    options: ['{{ ref() }}', '{{ source() }}', '{{ from() }}', '{{ table() }}'],
    answer: 1,
  },
  {
    question: 'Which materialization rebuilds the entire table on every run?',
    options: ['view', 'incremental', 'table', 'ephemeral'],
    answer: 2,
  },
  {
    question: 'Which materialization is inlined as a CTE into downstream models?',
    options: ['ephemeral', 'view', 'incremental', 'snapshot'],
    answer: 0,
  },
  {
    question: 'What is the purpose of `is_incremental()`?',
    options: [
      'Guard SQL that only runs on incremental rebuilds',
      'Force a full-refresh on the next run',
      'Mark a model as type incremental',
      'Skip the model if the source is unchanged',
    ],
    answer: 0,
  },
  {
    question: 'Which generic test enforces uniqueness on a column?',
    options: ['not_null', 'unique', 'accepted_values', 'relationships'],
    answer: 1,
  },
  {
    question: 'Which generic test enforces referential integrity to another model?',
    options: ['unique', 'not_null', 'relationships', 'foreign_key'],
    answer: 2,
  },
  {
    question: 'Snapshots track changes using which strategy by default?',
    options: ['timestamp', 'check', 'merge', 'incremental'],
    answer: 0,
  },
  {
    question: 'Which file declares package dependencies in dbt?',
    options: ['dbt_project.yml', 'profiles.yml', 'packages.yml', 'manifest.json'],
    answer: 2,
  },
  {
    question: 'Where are warehouse credentials configured?',
    options: ['dbt_project.yml', 'profiles.yml', 'packages.yml', '.env'],
    answer: 1,
  },
  {
    question: 'What is the artifact produced by `dbt compile`?',
    options: ['catalog.json', 'manifest.json', 'run_results.json', 'sources.json'],
    answer: 1,
  },
  {
    question: 'Which command runs only tests for a specific model and its descendants?',
    options: [
      'dbt test --select my_model',
      'dbt test --select my_model+',
      'dbt test --select +my_model',
      'dbt test --models my_model',
    ],
    answer: 1,
  },
  {
    question: 'The `+` operator in selectors means:',
    options: [
      'Run upstream parents',
      'Run downstream children (or both, depending on side)',
      'Run only the named node',
      'Run package nodes',
    ],
    answer: 1,
  },
  {
    question: 'Staging models should typically be materialized as:',
    options: ['table', 'view', 'incremental', 'ephemeral'],
    answer: 1,
  },
  {
    question: 'Which Jinja delimiter outputs a value into compiled SQL?',
    options: ['{% %}', '{{ }}', '{# #}', '<% %>'],
    answer: 1,
  },
  {
    question: 'Which Jinja delimiter wraps a comment that is stripped at compile time?',
    options: ['{# #}', '{{ }}', '{% %}', '// //'],
    answer: 0,
  },
  {
    question: 'What does `dbt build` do?',
    options: [
      'Only compiles SQL',
      'Runs models, then tests, then snapshots, then seeds, in DAG order',
      'Runs only models and tests',
      'Builds the docs site',
    ],
    answer: 1,
  },
  {
    question: 'Which command renders the docs site?',
    options: ['dbt docs build', 'dbt docs generate && dbt docs serve', 'dbt site', 'dbt run --docs'],
    answer: 1,
  },
  {
    question: 'A `singular` test in dbt is:',
    options: [
      'A test defined in a .sql file that returns failing rows',
      'A test that runs only once across the project',
      'A built-in generic test',
      'A test on a single column',
    ],
    answer: 0,
  },
  {
    question: 'Which config block sets the materialization for a model?',
    options: [
      '{{ config(materialized="table") }}',
      '{{ set materialized="table" }}',
      '{{ materialize="table" }}',
      '{{ type="table" }}',
    ],
    answer: 0,
  },
  {
    question: 'What does the dbt Semantic Layer expose?',
    options: ['Compiled SQL', 'Metrics defined via MetricFlow', 'Manifest nodes', 'Test failures'],
    answer: 1,
  },
  {
    question: 'In dbt Mesh, model `access: private` means:',
    options: [
      'Cannot be ref()ed from any project',
      'Cannot be ref()ed from outside its group',
      'Cannot be selected by dbt run',
      'Cannot be queried in the warehouse',
    ],
    answer: 1,
  },
  {
    question: 'Which file is used to declare cross-project dependencies in dbt Mesh?',
    options: ['packages.yml', 'dependencies.yml', 'dbt_project.yml', 'profiles.yml'],
    answer: 1,
  },
  {
    question: 'A model `contract` (enforced=true) is checked when?',
    options: [
      'At compile time only',
      'At build time, against the warehouse',
      'Only via CI',
      'When the docs site is generated',
    ],
    answer: 1,
  },
  {
    question: 'Which Jinja construct iterates over a list?',
    options: ['{% for %}', '{% loop %}', '{% each %}', '{% iterate %}'],
    answer: 0,
  },
  {
    question: 'A macro is invoked with:',
    options: ['{{ my_macro() }}', '{% my_macro() %}', '@my_macro()', 'macro(my_macro)'],
    answer: 0,
  },
  {
    question: 'What does `on_schema_change="sync_all_columns"` do?',
    options: [
      'Drops the table and rebuilds',
      'Adds new columns and removes ones no longer in the model',
      'Errors on any schema mismatch',
      'Renames columns to match the model',
    ],
    answer: 1,
  },
  {
    question: 'The `{{ this }}` Jinja variable refers to:',
    options: [
      'The currently compiling model',
      'The dbt project',
      'The current dbt run',
      'The last-built node',
    ],
    answer: 0,
  },
  {
    question: 'Which selector runs all models tagged "hourly"?',
    options: [
      'dbt run --tag hourly',
      'dbt run --select tag:hourly',
      'dbt run --models tag=hourly',
      'dbt run --tagged hourly',
    ],
    answer: 1,
  },
  {
    question: 'Which file lists allowed package versions in dbt Cloud / Core?',
    options: ['package-lock.yml', 'packages.yml + package-lock.yml', 'requirements.txt', 'lockfile.json'],
    answer: 1,
  },
  {
    question: 'Which Kimball term describes a slowly changing dimension that overwrites prior values?',
    options: ['Type 0', 'Type 1', 'Type 2', 'Type 3'],
    answer: 1,
  },
  {
    question: 'Which SCD type adds a new row with effective dates to preserve history?',
    options: ['Type 1', 'Type 2', 'Type 3', 'Type 6'],
    answer: 1,
  },
];
