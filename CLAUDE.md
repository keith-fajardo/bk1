# Project
I want to create a Terminal UI that is a coding agent for dbt called bk1. It's a play on words which stems from the Filipino word Bakawan which is the Filipino word for Mangrove. Mangrove is the company that I am in right now.

bk1 is a coding agent specifically created for dbt projects. It already understands what dbt is, what dbt syntax is, what platforms it can connect, and understands the best practices and the project structure so that I don't have to burn tokens to explain what I want to do.

# dbt Project Folder Structure
A good dbt project folder structure looks like this:

```
.
├── CLAUDE.md
├── analyses
├── dbt_packages
├── dbt_project.yml
├── logs
├── macros
│   ├── custom_materializations
│   │   ├── helpers
│   │   │   ├── build_temp_table.sql
│   │   │   ├── scd1
│   │   │   │   ├── build_scd1_staging_table.sql
│   │   │   │   ├── scd1_merge_sql.sql
│   │   │   │   └── scd1_staging_table_sql.sql
│   │   │   ├── scd1_table_sql.sql
│   │   │   ├── scd2
│   │   │   │   ├── build_scd2_staging_table.sql
│   │   │   │   ├── scd2_merge_sql.sql
│   │   │   │   └── scd2_staging_table_sql.sql
│   │   │   └── scd2_table_sql.sql
│   │   ├── scd1.sql
│   │   ├── scd2.sql
│   │   ├── scd_materialization_user_guide.md
│   │   └── surrogate_key.sql
│   ├── get_usage_type.sql
│   └── overrides
│       ├── redshift__get_columns_in_relation.sql
│       └── redshift__list_relations_without_caching.sql
├── models
│   ├── intermediate
│   │   └── finance
│   │       ├── int_account_dim.sql
│   │       ├── int_credit_memo_with_credit_memo_lines.sql
│   │       ├── int_credit_memo_with_credit_memo_lines.yml
│   │       ├── recurrent
│   │       │   ├── int_invoice_and_credit_memo_lines.sql
│   │       │   ├── int_invoice_and_credit_memo_lines.yml
│   │       │   ├── int_journal_synthetic_lines.sql
│   │       │   └── int_journal_synthetic_lines.yml
│   │       └── usage
│   │           ├── int_crm_usage_transactions_fact.sql
│   │           └── int_usage_transactions_fact.sql
│   ├── marts
│   │   ├── common
│   │   │   ├── dim_date.sql
│   │   ├── core
│   │   │   └── finance
│   │   │       ├── dim
│   │   │       │   ├── dim_account.sql
│   │   │       │   ├── dim_account.yml
│   │   │       │   ├── dim_netsuite_item.sql
│   │   │       │   ├── dim_netsuite_vertical.sql
│   │   │       │   ├── dim_price_book.sql
│   │   │       │   ├── dim_price_book.yml
│   │   │       │   ├── dim_rate_plan.sql
│   │   │       │   └── dim_rate_plan.yml
│   │   │       └── fact
│   │   │           ├── fct_invoices.sql
│   │   │           └── fct_invoices.yml
│   │   └── presentation
│   │       └── finance
│   │           ├── rpt_usage_revenue_reconciliations.sql
│   │           └── rpt_usage_revenue_reconciliations.yml
│   ├── sources
│   │   └── src_salesforce.yml
│   └── staging
│       ├── analytics
│       │   ├── stg_analytics__dim_date.sql
│       │   └── stg_analytics__dim_date.yml
│       ├── he_web
│       │   ├── stg_he_web__usage_ledger.sql
│       │   └── stg_he_web__usage_ledger.yml
│       ├── rogue
│       │   ├── stg_rogue__crm_usage.sql
│       │   └── stg_rogue__crm_usage.yml
│       └── salesforce
│           ├── stg_salesforce__opportunity.yml
│           └── stg_salesforce__record_type.sql
├── package-lock.yml
├── packages.yml
├── profiles.yml.template
├── pyproject.toml
├── seeds
│   ├── seed_usage_rate_exclusions.csv
│   └── seed_usage_rate_exclusions.yml
├── snapshots
├── target
│   ├── catalog.json
│   ├── compiled
│   ├── graph.gpickle
│   ├── graph_summary.json
│   ├── index.html
│   ├── manifest.json
│   ├── partial_parse.msgpack
│   ├── perf_info.json
│   ├── run
│   ├── run_results.json
│   └── semantic_manifest.json
├── tests
└── uv.lock
```

---

# dbt Project Rules
## General
* snake_case for field names
* order columns in models like so: ids, strings, numerics, booleans, dates, and timestamps.
* avoid abbreviations outside of folder structure labels where possible. E.g. 'stg_employment_hero__employees' is preferred to 'stg_eh__employees'.
* dbt models should follow naming standards and folder structure.
* dbt models should be in lowercase and snake case.
* the | character tells the YAML parser that what follows is a folded block scalar, meaning the text can span multiple lines in the file. Use it to keep your descriptions over multiple lines for legibility.

## Source Naming
* source yaml file name should have a prefix of "src_" i.e. src_salesforce.
* source yaml file name should contain the platform where the data is coming from and not the application that ingests it.
* sources yaml files should be under folder models/sources/

## Model Naming
* models should named appropriately based on the model layer.

## Staging Models
* staging models are located at "models/staging/"
* models should have a prefix of "stg_" the followed by the source system name then double underscore ("__") then the name of the source table.
  - Example:
      * stg_salesforce__invoices
* columns in the staging models should be explicitly retur and avoid `select *`.
* columns in the staging models should have castings into designed data types.
* staging models are materialized as views unless there is an explicit reason why. If the staging model will not be a view, it should be explicitly mentioned in the yaml file.
* there should not be heavy transformations or joins in the staging models.

## Intermediate Models
* intermediate models are located at "models/intermediate/"
* models should have a prefix of "int_" then followed by the context of what is the resulting dataset of the transformation.
* transformations that should live under this folder are:
  - joins
  - heavy transformations
  - business logic
* intermediate models are recommended to be materialized as tables for faster troubleshooting.

## Marts Models
* marts models are located at "models/marts/"
* marts should have 2 main sub-folders:
  - common/
  - core/
  - presentation/
* under "core/", marts will have their own separate folders and will contain the dims and facts
  - Example:

    ```
    │   ├── marts
    │   │   ├── common
    │   │   │   ├── dim_date.sql
    │   │   ├── core
    │   │   │   └── finance
    │   │   │       ├── dim
    │   │   │       │   ├── dim_account.sql
    │   │   │       │   ├── dim_account.yml
    │   │   │       └── fact
    │   │   │           ├── fct_invoices.sql
    │   │   │           └── fct_invoices.yml

    ```
* dimension tables will have a prefix of "dim_"
* dimension tables should be in singular form i.e. "dim_employee".
* fact tables will have a prefix of "fct_".
* fact tables should be in plural form i.e. "fct_invoices".
* bridge tables will have a naming format of "bridge_<entity_1>_<entity_2>".
* reporting models are under "presentation/" and will have a suffix of "rpt_".
* for fact models, the fact table type should be explicitly mentioned in the model yaml file i.e. snapshot fact table, adjunct fact table, factless fact table. If it's a normal fact table that contains events, there's no need to explicitly mention.    
* The SCD Type of the dimension tables should be explicitly specified in their yaml files i.e. SCD Type I, II, etc...
* dimension tables and fact tables should have their own primary key that numeric.
* If there are tables that are neither a dimension or a fact, create models under "common/" and the models should have a prefix of "lkp" that stands for "Lookup" if the nature of table is for lookup or reference table.
 
## Database & Schema Materialization
* staging models should be materialized under "staging" schema.
* intermediate models should be materialized under "intermediate" schema.
* marts models should be materialized under "marts" schema.
<!--
IGNORE THIS SINCE THE PROJECT DOES NOT HAVE SPECIFIC DATABASES FOR ENVIRONMENTS
* staging models should be materialized under "d_stg_" database.
* intermediate models should be materialized under "d_int_" database.
* marts models should be materialized under "d_mrt_" database.
* the prefix in the database indicates the environment:
  - d_ : development
  - q_ : qa
  - p_ : production
-->

## Model Documentation
* each model should have a model a pair model. For example: stg_salesforce__invoices.sql will have a partner yaml file stg_salesforce__invoices.yaml.
* models should be described with as much context as possible.
* columns in the yaml files should be described with as much context as possible.
* model schema/yaml files should only contain one model.

## Folder Navigation
| Want to… | Go here | Purpose |
|---|---|---|
| Look for sources | `models/sources/` | Contains all the source yamls |
| Look for staging | `models/staging/` | Contains all the staging models |
| Look for intermediate | `models/intermediate/` | Contains all the intermediate models |
| Look for all marts | `models/marts/` | Contains all the marts models |
| Look for all marts common | `models/marts/common/` | Contains all the common dimensions i.e. dim_date |
| Look for all finance marts | `models/marts/core/finance/` | Contains all the finance marts models |
| Look for all finance dimensions | `models/marts/core/finance/dim` | Contains all the finance marts dimension models |
| Look for all finance facts | `models/marts/core/finance/fact` | Contains all the finance marts facts models |
| Look for all finance bridges | `models/marts/core/finance/bridge` | Contains all the finance marts bridge models |

## Performance & cost
- Avoid `select *` in marts; be explicit.
- Push filters earlier; avoid unnecessary cross joins.
- Prefer incremental/partition strategies only when justified (and documented).
