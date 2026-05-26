import { describe, expect, test } from 'bun:test';
import { parseDbtSchemaYaml, projectContent } from '../src/state';

const SCHEMA = `version: 2

models:
  - name: stg_salesforce__opportunity
    description: |
      Staging model for Salesforce opportunities.
      Joins are deferred to intermediate.
    columns:
      - name: opportunity_id
        description: Primary key from Salesforce.
        data_type: varchar
      - name: account_id
        description: FK to account dimension.
        data_type: varchar
      - name: amount
        description: Opportunity dollar amount.
        data_type: numeric
      - name: is_closed
        description: |
          Whether the opportunity reached
          a terminal stage.
        data_type: boolean

  - name: dim_account
    description: "SCD Type II — tracks account history."
    columns:
      - name: account_key
        data_type: bigint
        description: Surrogate key.
      - name: account_name
        data_type: varchar
`;

describe('parseDbtSchemaYaml', () => {
  test('parses two models with mixed inline and block-scalar descriptions', () => {
    const models = parseDbtSchemaYaml(SCHEMA);
    expect(models).toHaveLength(2);

    expect(models[0]!.name).toBe('stg_salesforce__opportunity');
    expect(models[0]!.description).toContain('Staging model for Salesforce');
    expect(models[0]!.description).toContain('Joins are deferred');
    expect(models[0]!.columns).toHaveLength(4);

    const col0 = models[0]!.columns[0]!;
    expect(col0.name).toBe('opportunity_id');
    expect(col0.data_type).toBe('varchar');
    expect(col0.description).toBe('Primary key from Salesforce.');

    const colBlock = models[0]!.columns[3]!;
    expect(colBlock.name).toBe('is_closed');
    expect(colBlock.description).toContain('Whether the opportunity reached');
    expect(colBlock.description).toContain('terminal stage');

    expect(models[1]!.name).toBe('dim_account');
    expect(models[1]!.description).toBe('SCD Type II — tracks account history.');
    expect(models[1]!.columns.map(c => c.name)).toEqual(['account_key', 'account_name']);
  });

  test('handles a file with no models gracefully', () => {
    expect(parseDbtSchemaYaml('version: 2\nsources:\n  - name: foo')).toHaveLength(0);
    expect(parseDbtSchemaYaml('')).toHaveLength(0);
  });
});

describe('projectContent — YAML projections', () => {
  const path = 'models/staging/salesforce/stg_salesforce__opportunity.yml';

  test('descriptions projection keeps descriptions and drops data_type', () => {
    const out = projectContent(path, SCHEMA, 'descriptions')!;
    expect(out).toContain('stg_salesforce__opportunity');
    expect(out).toContain('Primary key from Salesforce.');
    expect(out).toContain('opportunity_id');
    // data_type should be filtered out
    expect(out).not.toContain('varchar');
    expect(out).not.toContain('numeric');
  });

  test('columns projection keeps name + data_type and drops descriptions', () => {
    const out = projectContent(path, SCHEMA, 'columns')!;
    expect(out).toContain('opportunity_id (varchar)');
    expect(out).toContain('amount (numeric)');
    expect(out).not.toContain('Primary key');
    expect(out).not.toContain('Opportunity dollar amount');
  });

  test('identifiers projection lists names only — much smaller', () => {
    const out = projectContent(path, SCHEMA, 'identifiers')!;
    expect(out).toContain('opportunity_id');
    expect(out).toContain('account_id');
    expect(out).not.toContain('varchar');
    expect(out).not.toContain('Primary key');
    // Bytes saved sanity check — identifiers projection should be < 25% of raw.
    expect(out.length).toBeLessThan(SCHEMA.length / 4);
  });

  test('model_description projection drops columns entirely', () => {
    const out = projectContent(path, SCHEMA, 'model_description')!;
    expect(out).toContain('stg_salesforce__opportunity');
    expect(out).toContain('Staging model for Salesforce');
    expect(out).not.toContain('opportunity_id');
    expect(out).not.toContain('amount');
  });

  test('sql_compact projection is null for YAML files', () => {
    expect(projectContent(path, SCHEMA, 'sql_compact')).toBeNull();
  });
});

describe('projectContent — SQL projection', () => {
  const sql = `-- This staging model casts types
with src as (

    select * from {{ ref('raw_orders') }}  -- alias the raw table

),

/*
  Final projection — keep columns explicit
  per project rules.
*/
final as (
    select
        order_id::bigint as order_id,  -- ids first
        customer_name::varchar as customer_name,
        amount::numeric as amount
    from src
)

select * from final
`;

  test('sql_compact strips comments and blank lines but keeps statements', () => {
    const out = projectContent('models/staging/stg_orders.sql', sql, 'sql_compact')!;
    expect(out).not.toContain('--');
    expect(out).not.toContain('/*');
    expect(out).not.toContain('Final projection');
    expect(out).toContain("select * from {{ ref('raw_orders') }}");
    expect(out).toContain('select * from final');
    expect(out).toContain('amount::numeric as amount');
    // No blank lines
    expect(out.split('\n').some(l => l.trim() === '')).toBe(false);
  });

  test('YAML projections return null for SQL files', () => {
    expect(projectContent('models/staging/stg_orders.sql', sql, 'descriptions')).toBeNull();
    expect(projectContent('models/staging/stg_orders.sql', sql, 'identifiers')).toBeNull();
  });
});
