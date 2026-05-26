import { describe, expect, test } from 'bun:test';
import { traceColumns, propagateColumnTaint, pickDialect } from '../src/lineage';

describe('traceColumns', () => {
  test('named columns through a CTE', () => {
    const sql = `with renamed as (select id as account_id, customer_id from raw.accounts) select account_id, customer_id from renamed`;
    const result = traceColumns(sql);
    expect(result.columns.account_id).toEqual([{ table: 'accounts', column: 'id' }]);
    expect(result.columns.customer_id).toEqual([{ table: 'accounts', column: 'customer_id' }]);
    expect(result.unsupported).toEqual({});
    expect(result.fatal).toBeUndefined();
  });

  test('dbt-idiomatic `select * from final` expands via the CTE', () => {
    // This is the dominant dbt pattern. If this regresses, /impact reports "fatal" on
    // basically every well-formed dbt model.
    const sql = `with source as (select * from raw.accounts), renamed as (select id::integer as account_id, name::varchar as account_name from source) select * from renamed`;
    const result = traceColumns(sql);
    expect(result.fatal).toBeUndefined();
    expect(result.columns.account_id).toEqual([{ table: 'accounts', column: 'id' }]);
    expect(result.columns.account_name).toEqual([{ table: 'accounts', column: 'name' }]);
  });

  test('cast is transparent — attribution survives type changes', () => {
    const result = traceColumns(`select cast(amount as numeric) as amt from raw.orders`);
    expect(result.columns.amt).toEqual([{ table: 'orders', column: 'amount' }]);
  });

  test('coalesce surfaces both source columns', () => {
    const result = traceColumns(`select coalesce(first_name, last_name) as name from raw.users`);
    expect(result.columns.name).toEqual([
      { table: 'users', column: 'first_name' },
      { table: 'users', column: 'last_name' },
    ]);
  });

  test('JOIN with explicit qualification — each output attributed to the right side', () => {
    const sql = `select o.id, c.name from raw.orders o inner join raw.customers c on o.customer_id = c.id`;
    const result = traceColumns(sql);
    expect(result.columns.id).toEqual([{ table: 'orders', column: 'id' }]);
    expect(result.columns.name).toEqual([{ table: 'customers', column: 'name' }]);
  });

  test('window function output column is flagged unsupported, other columns still traced', () => {
    // Important: one unsupported column should NOT poison the rest. This is the contract
    // that lets /impact still report partial-but-useful results.
    const sql = `select id, row_number() over (partition by customer_id order by id) as rn from raw.orders`;
    const result = traceColumns(sql);
    expect(result.columns.id).toEqual([{ table: 'orders', column: 'id' }]);
    expect(result.columns.rn).toBeNull();
    expect(result.unsupported.rn).toContain('window');
  });

  test('aggregations (sum/avg) surface as unsupported in v1', () => {
    const sql = `select customer_id, sum(amount) as total from raw.orders group by customer_id`;
    const result = traceColumns(sql);
    expect(result.columns.customer_id).toEqual([{ table: 'orders', column: 'customer_id' }]);
    expect(result.columns.total).toBeNull();
    expect(result.unsupported.total).toContain('aggregation');
  });

  test('parse failure surfaces as a fatal', () => {
    const result = traceColumns(`this is not sql at all`);
    expect(result.fatal).toBeDefined();
    expect(result.columns).toEqual({});
  });

  test('select * from a raw table is unsupported (no column catalog)', () => {
    const result = traceColumns(`select * from raw.orders`);
    expect(result.fatal).toBeDefined();
  });
});

describe('propagateColumnTaint', () => {
  test('propagates rename through a multi-hop chain', () => {
    // This is the load-bearing test for the /impact .column feature. If taint stops
    // propagating across renames, the whole column-lineage UI is misleading.
    const result = propagateColumnTaint({
      targetModel: 'stg_orders',
      targetColumn: 'customer_id',
      modelsInOrder: [
        { name: 'int_acc',    compiledSql: `with src as (select * from stg_orders), final as (select customer_id from src) select * from final` },
        { name: 'fct_rev',    compiledSql: `with src as (select customer_id from int_acc), final as (select customer_id as cust_id from src) select * from final` },
        { name: 'rpt_kpi',    compiledSql: `select cust_id from fct_rev` },
      ],
    });
    expect(result.taint.stg_orders).toEqual(['customer_id']);
    expect(result.taint.int_acc).toEqual(['customer_id']);
    expect(result.taint.fct_rev).toEqual(['cust_id']);
    expect(result.taint.rpt_kpi).toEqual(['cust_id']);
    expect(result.perModelStatus.int_acc?.status).toBe('traced');
    expect(result.perModelStatus.fct_rev?.status).toBe('traced');
  });

  test('a parse-failed model breaks the chain but does not poison sibling subgraphs', () => {
    const result = propagateColumnTaint({
      targetModel: 'stg_orders',
      targetColumn: 'amount',
      modelsInOrder: [
        { name: 'broken',  compiledSql: `garbage sql ((` },
        { name: 'sibling', compiledSql: `select amount from stg_orders` },
      ],
    });
    expect(result.perModelStatus.broken?.status).toBe('parse_failed');
    expect(result.taint.sibling).toEqual(['amount']);
  });

  test('missing compiled SQL is reported per-model without failing the run', () => {
    const result = propagateColumnTaint({
      targetModel: 'stg_orders',
      targetColumn: 'amount',
      modelsInOrder: [
        { name: 'no_compile', compiledSql: null },
      ],
    });
    expect(result.perModelStatus.no_compile?.status).toBe('sql_missing');
    expect(result.taint.no_compile).toBeUndefined();
  });
});

describe('pickDialect', () => {
  test('maps common warehouse types to node-sql-parser dialects', () => {
    expect(pickDialect('postgres')).toBe('postgresql');
    expect(pickDialect('redshift')).toBe('postgresql');
    expect(pickDialect('snowflake')).toBe('snowflake');
    expect(pickDialect('bigquery')).toBe('bigquery');
    expect(pickDialect('duckdb')).toBe('postgresql');
  });

  test('unknown / missing warehouse defaults to postgresql', () => {
    expect(pickDialect(undefined)).toBe('postgresql');
    expect(pickDialect(null)).toBe('postgresql');
    expect(pickDialect('exotic_warehouse')).toBe('postgresql');
  });
});
