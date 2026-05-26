use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::types::{ClaudeMdInfo, Violation};

fn rel(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn ucfirst(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().to_string() + c.as_str(),
    }
}

fn sql_files(dir: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("sql"))
}

fn yml_files(dir: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("yml"))
}

// ── 1. Naming conventions ─────────────────────────────────────────────────────

pub fn naming(root: &Path, info: &ClaudeMdInfo) -> Vec<Violation> {
    if !info.found {
        return vec![];
    }
    let mut v = Vec::new();

    // Staging
    let staging_dir = root.join(&info.staging_folder);
    if staging_dir.exists() && info.has_staging {
        let double_re = Regex::new(r"^stg_[a-z0-9_]+__[a-z0-9_]+\.sql$").unwrap();
        for e in sql_files(&staging_dir) {
            let name = e.file_name().to_string_lossy().to_string();
            let ok = if info.staging_double_sep {
                double_re.is_match(&name)
            } else {
                name.starts_with("stg_")
            };
            if !ok {
                let (rule, fix) = if info.staging_double_sep {
                    (
                        "Staging model filename must follow stg_<source>__<table>.sql",
                        "Rename to stg_<source>__<table>.sql (double underscore separator)",
                    )
                } else {
                    ("Staging model filename must start with stg_", "Rename to stg_<name>.sql")
                };
                v.push(Violation::mechanical(
                    "stg_naming", rule, "major", &rel(e.path(), root),
                    &format!("filename: {name}"), fix,
                ));
            }
        }
    }

    // Intermediate
    let int_dir = root.join(&info.intermediate_folder);
    if int_dir.exists() && info.has_intermediate {
        for e in sql_files(&int_dir) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("int_") {
                v.push(Violation::mechanical(
                    "int_naming",
                    "Intermediate model filename must start with int_",
                    "major", &rel(e.path(), root),
                    &format!("filename: {name}"), "Rename to int_<name>.sql",
                ));
            }
        }
    }

    // Marts
    let marts_dir = root.join(&info.marts_folder);
    if marts_dir.exists() {
        let prefixes: Vec<&str> = [
            (info.has_dim, "dim_"), (info.has_fct, "fct_"), (info.has_bridge, "bridge_"),
            (info.has_rpt, "rpt_"), (info.has_lkp, "lkp_"),
        ]
        .iter()
        .filter(|(flag, _)| *flag)
        .map(|(_, p)| *p)
        .collect();

        if !prefixes.is_empty() {
            for e in sql_files(&marts_dir) {
                let name = e.file_name().to_string_lossy().to_string();
                if !prefixes.iter().any(|p| name.starts_with(p)) {
                    let joined = prefixes.join(", ");
                    v.push(Violation::mechanical(
                        "mart_naming",
                        &format!("Marts model filename must start with one of: {joined}"),
                        "major", &rel(e.path(), root),
                        &format!("filename: {name}"),
                        &format!("Rename with appropriate prefix ({joined})"),
                    ));
                }
            }
        }
    }

    // Source YAML naming
    let sources_dir = root.join(&info.sources_folder);
    if sources_dir.exists() {
        for e in yml_files(&sources_dir) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("src_") {
                v.push(Violation::mechanical(
                    "src_naming",
                    "Source YAML filename must start with src_",
                    "major", &rel(e.path(), root),
                    &format!("filename: {name}"), "Rename to src_<name>.yml",
                ));
            }
        }
    }

    v
}

// ── 2. Folder placement ───────────────────────────────────────────────────────

pub fn placement(root: &Path, info: &ClaudeMdInfo) -> Vec<Violation> {
    if !info.found {
        return vec![];
    }
    let mut v = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return v;
    }

    for (flag, prefix, expected, label) in &[
        (info.has_staging, "stg_", &info.staging_folder, "staging"),
        (info.has_intermediate, "int_", &info.intermediate_folder, "intermediate"),
    ] {
        if !flag {
            continue;
        }
        for e in sql_files(&models_root) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(prefix) {
                continue;
            }
            let r = rel(e.path(), root);
            if !r.starts_with(expected.as_str()) {
                v.push(Violation::mechanical(
                    &format!("{label}_placement"),
                    &format!("{} models ({prefix}*) must live under {expected}/", ucfirst(label)),
                    "major", &r,
                    &format!("{prefix} model found outside {expected}/"),
                    &format!("Move to {expected}/{name}"),
                ));
            }
        }
    }

    for (flag, prefix) in &[
        (info.has_dim, "dim_"), (info.has_fct, "fct_"), (info.has_bridge, "bridge_"),
    ] {
        if !flag {
            continue;
        }
        for e in sql_files(&models_root) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(prefix) {
                continue;
            }
            let r = rel(e.path(), root);
            if !r.starts_with(info.marts_folder.as_str()) {
                v.push(Violation::mechanical(
                    "mart_placement",
                    &format!("Marts models ({prefix}*) must live under {}/", info.marts_folder),
                    "major", &r,
                    &format!("{prefix} model found outside {}/", info.marts_folder),
                    &format!("Move to {}/{name}", info.marts_folder),
                ));
            }
        }
    }

    v
}

// ── 3. Source location ────────────────────────────────────────────────────────

pub fn source_location(root: &Path, info: &ClaudeMdInfo) -> Vec<Violation> {
    let mut v = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return v;
    }
    let sources_re = Regex::new(r"(?m)^sources\s*:").unwrap();
    let sources_prefix = &info.sources_folder;

    for e in yml_files(&models_root) {
        let r = rel(e.path(), root);
        if r.starts_with(sources_prefix.as_str()) {
            continue;
        }
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if sources_re.is_match(&text) {
            v.push(Violation::mechanical(
                "src_location",
                &format!("Source YAML declarations must live under {sources_prefix}/"),
                "major", &r,
                "File contains top-level 'sources:' key but is outside the sources folder",
                &format!("Move source declarations to {sources_prefix}/src_<name>.yml"),
            ));
        }
    }
    v
}

// ── 4. Paired YAMLs ───────────────────────────────────────────────────────────

pub fn paired_yamls(root: &Path) -> Vec<Violation> {
    let mut v = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return v;
    }

    let name_re = Regex::new(r"(?m)^\s{2,6}-\s+name:\s+(\S+)").unwrap();
    let mut documented: HashSet<String> = HashSet::new();

    for e in yml_files(&models_root) {
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for cap in name_re.captures_iter(&text) {
            documented.insert(cap[1].trim().to_string());
        }
    }

    for e in sql_files(&models_root) {
        let stem = e.path().file_stem().unwrap().to_string_lossy().to_string();
        if !documented.contains(&stem) {
            v.push(Violation::mechanical(
                "paired_yaml",
                "Every model must have a paired YAML schema entry",
                "major", &rel(e.path(), root),
                &format!("No YAML entry found for model '{stem}'"),
                &format!("Add a schema entry for '{stem}' in an adjacent .yml file"),
            ));
        }
    }
    v
}

// ── 5. YAML documentation ─────────────────────────────────────────────────────

pub fn yaml_docs(root: &Path, info: &ClaudeMdInfo) -> (Vec<Violation>, Vec<String>) {
    let mut v = Vec::new();
    let mut files_with_real_desc: Vec<String> = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return (v, files_with_real_desc);
    }

    let placeholder_re = Regex::new(
        r#"(?i)^\s*(todo|tbd|n/?a|placeholder|fill[\s_]?in|add[\s_]?desc(?:ription)?)?\s*$"#,
    ).unwrap();
    let sources_only_re = Regex::new(r"(?m)^sources\s*:").unwrap();
    let models_key_re = Regex::new(r"(?m)^models\s*:").unwrap();
    let model_entry_re = Regex::new(r"(?m)^\s{2,4}-\s+name:\s+(\S+)").unwrap();
    let col_entry_re = Regex::new(r"(?m)^\s+-\s+name:\s+(\S+)").unwrap();
    let block_desc_re = Regex::new(r"description:\s*[|>]").unwrap();
    let inline_desc_re = Regex::new(r"description:\s*(.+)").unwrap();
    let has_real_re = Regex::new(r"description:\s*[|>]").unwrap();

    for e in yml_files(&models_root) {
        let r = rel(e.path(), root);
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Skip source-only files
        if sources_only_re.is_match(&text) && !models_key_re.is_match(&text) {
            continue;
        }

        let model_caps: Vec<_> = model_entry_re.captures_iter(&text).collect();
        for (idx, m) in model_caps.iter().enumerate() {
            let model_name = m[1].to_string();
            let block_start = m.get(0).unwrap().end();
            let block_end = model_caps
                .get(idx + 1)
                .map(|nm| nm.get(0).unwrap().start())
                .unwrap_or(text.len());
            let block = &text[block_start..block_end];

            // Model description
            if let Some(dm) = inline_desc_re.captures(block) {
                let val = dm[1].trim().trim_matches('"').trim_matches('\'');
                if placeholder_re.is_match(val) && !block_desc_re.is_match(block) {
                    v.push(Violation::mechanical(
                        "model_desc",
                        "Model description must not be empty or a placeholder",
                        "major", &r,
                        &format!("model '{model_name}' description: \"{val}\""),
                        &format!("Replace with a meaningful description for '{model_name}'"),
                    ));
                }
            } else {
                v.push(Violation::mechanical(
                    "model_desc",
                    "Every model must have a description",
                    "major", &r,
                    &format!("model '{model_name}' has no description field"),
                    &format!("Add `description:` to the '{model_name}' YAML entry"),
                ));
            }

            // Column descriptions
            if let Some(cols_pos) = block.find("columns:") {
                let cols_text = &block[cols_pos..];
                let col_caps: Vec<_> = col_entry_re.captures_iter(cols_text).collect();
                for (cidx, cm) in col_caps.iter().enumerate() {
                    let col_name = cm[1].to_string();
                    let cs = cm.get(0).unwrap().end();
                    let ce = col_caps
                        .get(cidx + 1)
                        .map(|nc| nc.get(0).unwrap().start())
                        .unwrap_or(cols_text.len());
                    let col_block = &cols_text[cs..ce];
                    if !col_block.contains("description") {
                        v.push(Violation::mechanical(
                            "col_desc",
                            "Every column must have a description",
                            "minor", &r,
                            &format!("column '{col_name}' in model '{model_name}' has no description"),
                            &format!("Add `description:` to the '{col_name}' column entry"),
                        ));
                    }
                }
            }
        }

        // Pipe scalar check
        if info.requires_pipe_scalar {
            let folded_re = Regex::new(r"description:\s*>").unwrap();
            if folded_re.is_match(&text) {
                v.push(Violation::mechanical(
                    "pipe_scalar",
                    "Multi-line descriptions must use | (literal block scalar), not >",
                    "minor", &r,
                    "description uses > (folded scalar)",
                    "Replace > with | for multi-line description values",
                ));
            }
        }

        // Track files that have real (non-placeholder) descriptions
        if has_real_re.is_match(&text) {
            files_with_real_desc.push(r.clone());
        } else {
            for dm in inline_desc_re.captures_iter(&text) {
                let val = dm[1].trim().trim_matches('"').trim_matches('\'');
                if !placeholder_re.is_match(val) && val.len() > 15 {
                    files_with_real_desc.push(r.clone());
                    break;
                }
            }
        }
    }

    (v, files_with_real_desc)
}

// ── 6. SELECT * candidates ────────────────────────────────────────────────────

pub fn select_star(root: &Path) -> (Vec<Violation>, Vec<String>) {
    let mut violations = Vec::new();
    let mut candidates = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return (violations, candidates);
    }

    let has_star = Regex::new(r"(?i)\bselect\s+\*\b").unwrap();
    let has_terminal = Regex::new(r"(?i)\bselect\s+\*\s+from\s+(final|renamed)\b").unwrap();

    for e in sql_files(&models_root) {
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if has_star.is_match(&text) && !has_terminal.is_match(&text) {
            let r = rel(e.path(), root);
            violations.push(Violation::mechanical(
                "select_star",
                "No bare SELECT * in final output",
                "major", &r,
                "SELECT * found without terminal 'select * from final/renamed' pattern",
                "List columns explicitly or ensure the model ends with 'select * from final'",
            ));
            candidates.push(r);
        }
    }
    (violations, candidates)
}

// ── 7. SQL static analysis ────────────────────────────────────────────────────

pub fn sql_static(root: &Path) -> Vec<Violation> {
    let mut v = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return v;
    }

    let alias_re = Regex::new(r"(?i)\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)").unwrap();
    let has_upper = Regex::new(r"[A-Z]").unwrap();
    let cast_re = Regex::new(r"(?i)::[a-zA-Z]|CAST\s*\(").unwrap();
    let jinja_line = Regex::new(r"\{[{%]").unwrap();

    for e in sql_files(&models_root) {
        let r = rel(e.path(), root);
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Non-jinja lines only for alias check
        let clean: String = text
            .lines()
            .filter(|l| !jinja_line.is_match(l))
            .collect::<Vec<_>>()
            .join("\n");

        // snake_case alias check
        for cap in alias_re.captures_iter(&clean) {
            let alias = &cap[1];
            if alias.len() <= 2 || is_sql_keyword(alias) {
                continue;
            }
            if has_upper.is_match(alias) {
                v.push(Violation::mechanical(
                    "alias_case",
                    "Column aliases must be snake_case",
                    "minor", &r,
                    &format!("non-snake_case alias: {alias}"),
                    &format!("Rename to {}", to_snake(alias)),
                ));
                break;
            }
        }

        // Staging cast check
        if r.contains("staging") && !cast_re.is_match(&text) {
            v.push(Violation::mechanical(
                "staging_cast",
                "Staging models should explicitly cast columns to their intended types",
                "minor", &r,
                "No :: cast or CAST() found in staging model",
                "Add explicit type casts (e.g. column_name::integer) to all columns",
            ));
        }
    }
    v
}

fn is_sql_keyword(s: &str) -> bool {
    matches!(
        s.to_uppercase().as_str(),
        "AS" | "FROM" | "WHERE" | "JOIN" | "LEFT" | "RIGHT" | "INNER" | "OUTER"
            | "ON" | "AND" | "OR" | "NOT" | "IN" | "IS" | "NULL" | "TRUE" | "FALSE"
            | "SELECT" | "DISTINCT" | "GROUP" | "BY" | "ORDER" | "HAVING" | "LIMIT"
            | "CASE" | "WHEN" | "THEN" | "ELSE" | "END" | "UNION" | "ALL" | "WITH"
            | "OVER" | "PARTITION" | "ROWS" | "RANGE" | "BETWEEN" | "UNBOUNDED"
            | "PRECEDING" | "FOLLOWING" | "CURRENT" | "ROW" | "COALESCE" | "NULLIF"
            | "IFF" | "IIF" | "NVL" | "DECODE" | "LEAST" | "GREATEST"
    )
}

fn to_snake(s: &str) -> String {
    let re = Regex::new(r"([a-z0-9])([A-Z])").unwrap();
    re.replace_all(s, "${1}_${2}").to_lowercase()
}

// ── 8. Materialization ────────────────────────────────────────────────────────

pub fn materialization(root: &Path, info: &ClaudeMdInfo) -> Vec<Violation> {
    let mut v = Vec::new();
    let mat_re = Regex::new(r#"(?i)materialized\s*=\s*['"](\w+)['"]"#).unwrap();
    let scd_re = Regex::new(r"(?i)SCD\s+[Tt]ype|Type\s+[IVX0-9]+|scd_type").unwrap();
    let dim_name_re = Regex::new(r"(?m)^\s{2,4}-\s+name:\s+(dim_\S+)").unwrap();

    // Staging → must be views
    let staging_dir = root.join(&info.staging_folder);
    if staging_dir.exists() {
        for e in sql_files(&staging_dir) {
            let text = match fs::read_to_string(e.path()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if let Some(cap) = mat_re.captures(&text) {
                let mat = cap[1].to_lowercase();
                if mat != "view" && mat != "ephemeral" {
                    v.push(Violation::mechanical(
                        "stg_materialization",
                        "Staging models should be materialized as views",
                        "minor", &rel(e.path(), root),
                        &format!("materialized = '{mat}'"),
                        "Set materialized = 'view' or remove config block (view is default)",
                    ));
                }
            }
        }
    }

    // Intermediate → should be tables (flag if set to view)
    let int_dir = root.join(&info.intermediate_folder);
    if int_dir.exists() {
        for e in sql_files(&int_dir) {
            let text = match fs::read_to_string(e.path()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if let Some(cap) = mat_re.captures(&text) {
                if cap[1].to_lowercase() == "view" {
                    v.push(Violation::mechanical(
                        "int_materialization",
                        "Intermediate models are recommended to be materialized as tables",
                        "minor", &rel(e.path(), root),
                        "materialized = 'view'",
                        "Set materialized = 'table' for faster troubleshooting",
                    ));
                }
            }
        }
    }

    // Dimension YAML → must document SCD type
    if info.has_dim {
        let marts_dir = root.join(&info.marts_folder);
        if marts_dir.exists() {
            for e in yml_files(&marts_dir) {
                let text = match fs::read_to_string(e.path()) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let caps: Vec<_> = dim_name_re.captures_iter(&text).collect();
                for (idx, m) in caps.iter().enumerate() {
                    let model_name = m[1].to_string();
                    let bs = m.get(0).unwrap().end();
                    let be = caps
                        .get(idx + 1)
                        .map(|nm| nm.get(0).unwrap().start())
                        .unwrap_or(text.len());
                    let block = &text[bs..be];
                    if !scd_re.is_match(block) {
                        v.push(Violation::mechanical(
                            "scd_type",
                            "Dimension tables must specify their SCD type in YAML",
                            "minor", &rel(e.path(), root),
                            &format!("dim model '{model_name}' has no SCD type in description"),
                            "Add SCD Type (I, II, etc.) to the model description",
                        ));
                    }
                }
            }
        }
    }

    v
}

// ── 9. YAML model extraction (shared helper) ──────────────────────────────────
//
// Used by column_ordering and abbreviation checks. Mirrors the line-based
// parser in src/state.ts::parseDbtSchemaYaml — same semantics, Rust-side.

#[derive(Debug, Clone)]
pub struct YamlColumn {
    pub name: String,
    pub data_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct YamlModel {
    pub name: String,
    pub description_block: String,
    pub columns: Vec<YamlColumn>,
}

pub fn extract_models(text: &str) -> Vec<YamlModel> {
    let model_re = Regex::new(r"(?m)^(?P<ind>\s{2,4})-\s+name:\s+(?P<name>\S+)").unwrap();
    let col_re = Regex::new(r"(?m)^\s+-\s+name:\s+(\S+)").unwrap();
    let dtype_re = Regex::new(r"(?m)^\s+data_type:\s+(\S+)").unwrap();

    let caps: Vec<_> = model_re.captures_iter(text).collect();
    let mut out = Vec::new();
    for (i, m) in caps.iter().enumerate() {
        let name = m["name"].to_string();
        let start = m.get(0).unwrap().end();
        let end = caps
            .get(i + 1)
            .map(|n| n.get(0).unwrap().start())
            .unwrap_or(text.len());
        let block = &text[start..end];

        let mut columns = Vec::new();
        if let Some(cols_pos) = block.find("columns:") {
            let cols_text = &block[cols_pos..];
            let col_caps: Vec<_> = col_re.captures_iter(cols_text).collect();
            for (ci, cm) in col_caps.iter().enumerate() {
                let cs = cm.get(0).unwrap().end();
                let ce = col_caps
                    .get(ci + 1)
                    .map(|nc| nc.get(0).unwrap().start())
                    .unwrap_or(cols_text.len());
                let col_block = &cols_text[cs..ce];
                let data_type = dtype_re
                    .captures(col_block)
                    .map(|c| c[1].trim_matches('"').trim_matches('\'').to_string());
                columns.push(YamlColumn {
                    name: cm[1].to_string(),
                    data_type,
                });
            }
        }

        out.push(YamlModel {
            name,
            description_block: block.to_string(),
            columns,
        });
    }
    out
}

// ── 10. Column ordering (rule B) ──────────────────────────────────────────────
//
// Column order in YAML must be: ids → strings → numerics → booleans → dates → timestamps.
// Categories are inferred from data_type plus the column name (anything ending in
// `_id` or named `id` is an id, regardless of declared type). Columns without a
// declared data_type that aren't ids are treated as unknown and skipped — we don't
// have enough information to judge them.

fn classify_column(name: &str, data_type: Option<&str>) -> Option<u8> {
    let n = name.to_lowercase();
    if n == "id" || n.ends_with("_id") || n.ends_with("_key") || n == "key" {
        return Some(0); // id
    }
    let dt = match data_type {
        Some(t) => t.to_lowercase(),
        None => return None,
    };
    // Order matters: check timestamp before date (since "timestamp" contains "time").
    if dt.contains("timestamp") || dt.contains("datetime") {
        return Some(5);
    }
    if dt.starts_with("date") {
        return Some(4);
    }
    if dt.contains("bool") {
        return Some(3);
    }
    if dt.contains("int")
        || dt.contains("numeric")
        || dt.contains("number")
        || dt.contains("decimal")
        || dt.contains("float")
        || dt.contains("double")
        || dt.contains("real")
    {
        return Some(2);
    }
    if dt.contains("char") || dt.contains("text") || dt.contains("string") || dt.contains("varchar")
    {
        return Some(1);
    }
    None
}

pub fn column_ordering(root: &Path) -> Vec<Violation> {
    let mut v = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return v;
    }

    let category_names = ["id", "string", "numeric", "boolean", "date", "timestamp"];

    for e in yml_files(&models_root) {
        let r = rel(e.path(), root);
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };

        for m in extract_models(&text) {
            // Need at least 2 typed columns to judge ordering.
            let typed: Vec<(String, u8)> = m
                .columns
                .iter()
                .filter_map(|c| classify_column(&c.name, c.data_type.as_deref()).map(|cat| (c.name.clone(), cat)))
                .collect();
            if typed.len() < 2 {
                continue;
            }

            let mut max_seen: u8 = 0;
            for (col_name, cat) in &typed {
                if *cat < max_seen {
                    v.push(Violation::mechanical(
                        "col_order",
                        "Columns must be ordered: ids, strings, numerics, booleans, dates, timestamps",
                        "minor",
                        &r,
                        &format!(
                            "column '{col_name}' is a {} but follows a {} in model '{}'",
                            category_names[*cat as usize],
                            category_names[max_seen as usize],
                            m.name,
                        ),
                        "Reorder columns: ids first, then strings, numerics, booleans, dates, timestamps",
                    ));
                    break; // one violation per model is enough
                }
                if *cat > max_seen {
                    max_seen = *cat;
                }
            }
        }
    }

    v
}

// ── 11. Abbreviation usage (rule D) ───────────────────────────────────────────
//
// Flags model and column names that contain common abbreviations (emp, inv,
// acct, etc.). Whitelist allows standard SQL abbreviations (id, url, uuid),
// and folder-level prefixes (stg_, int_, dim_, fct_, rpt_, lkp_, bridge_) are
// skipped when they appear as the first token.

fn abbreviation_set() -> HashSet<&'static str> {
    [
        "emp", "inv", "acct", "cust", "prod", "qty", "amt", "addr", "txn", "mgr",
        "dept", "pmt", "prc", "yr", "mth", "wk", "hr", "min", "sec", "num", "cnt",
        "avg", "tot", "sub", "src", "dst", "msg", "err", "cfg", "env", "sys",
        "app", "svc", "pwd", "usr", "mbr", "ord", "co", "comp", "desc",
        "loc", "dt", "ts", "yrs", "mths", "wks", "hrs", "mins", "secs", "qrtr",
        "biz", "info", "ref",
    ]
    .iter()
    .copied()
    .collect()
}

fn folder_prefix_set() -> HashSet<&'static str> {
    ["stg", "int", "dim", "fct", "rpt", "lkp", "bridge", "fact", "dims", "facts"]
        .iter()
        .copied()
        .collect()
}

fn allow_short() -> HashSet<&'static str> {
    // Standard short tokens that aren't really abbreviations
    ["id", "url", "uri", "uuid", "ip", "kpi", "sku", "ssn", "eta", "ip", "us", "uk", "eu", "fk", "pk"]
        .iter()
        .copied()
        .collect()
}

fn find_abbrev_in_identifier(ident: &str, abbrevs: &HashSet<&str>, prefixes: &HashSet<&str>, allow: &HashSet<&str>) -> Option<String> {
    let lower = ident.to_lowercase();
    let tokens: Vec<&str> = lower.split('_').collect();
    for (i, tok) in tokens.iter().enumerate() {
        if tok.is_empty() {
            continue;
        }
        if i == 0 && prefixes.contains(tok) {
            continue;
        }
        if allow.contains(tok) {
            continue;
        }
        if abbrevs.contains(tok) {
            return Some(tok.to_string());
        }
    }
    None
}

pub fn abbreviation(root: &Path) -> Vec<Violation> {
    let mut v = Vec::new();
    let models_root = root.join("models");
    if !models_root.exists() {
        return v;
    }

    let abbrevs = abbreviation_set();
    let prefixes = folder_prefix_set();
    let allow = allow_short();

    for e in yml_files(&models_root) {
        let r = rel(e.path(), root);
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };

        for m in extract_models(&text) {
            if let Some(tok) = find_abbrev_in_identifier(&m.name, &abbrevs, &prefixes, &allow) {
                v.push(Violation::mechanical(
                    "abbreviation",
                    "Model and column names must avoid abbreviations",
                    "minor",
                    &r,
                    &format!("model '{}' contains abbreviation '{tok}'", m.name),
                    &format!("Rename — expand '{tok}' to its full form (e.g. 'emp' → 'employee')"),
                ));
            }
            for c in &m.columns {
                if let Some(tok) = find_abbrev_in_identifier(&c.name, &abbrevs, &prefixes, &allow) {
                    v.push(Violation::mechanical(
                        "abbreviation",
                        "Model and column names must avoid abbreviations",
                        "minor",
                        &r,
                        &format!("column '{}' in model '{}' contains abbreviation '{tok}'", c.name, m.name),
                        &format!("Rename — expand '{tok}' to its full form (e.g. 'emp' → 'employee')"),
                    ));
                }
            }
        }
    }

    v
}

// ── 12. SCD description quality (rule E extension) ────────────────────────────
//
// The existing scd_type check flags dim_ models missing any SCD mention.
// This adds a quality check: a dim_ model whose description is *just* a
// bare "SCD Type II" with no surrounding explanation isn't sufficient.

pub fn scd_quality(root: &Path, info: &ClaudeMdInfo) -> Vec<Violation> {
    let mut v = Vec::new();
    if !info.has_dim {
        return v;
    }
    let marts_dir = root.join(&info.marts_folder);
    if !marts_dir.exists() {
        return v;
    }

    let scd_re = Regex::new(r"(?i)SCD\s+[Tt]ype\s+[IVX0-9]+").unwrap();
    let desc_re = Regex::new(r"(?ms)description:\s*\|\s*\n((?:\s+.*\n?)+?)(?=\s*\w+:|\z)").unwrap();
    let inline_desc_re = Regex::new(r"description:\s*(.+)").unwrap();

    for e in yml_files(&marts_dir) {
        let r = rel(e.path(), root);
        let text = match fs::read_to_string(e.path()) {
            Ok(t) => t,
            Err(_) => continue,
        };

        for m in extract_models(&text) {
            if !m.name.starts_with("dim_") {
                continue;
            }
            // Pull the description text — block scalar takes precedence.
            let desc_text = desc_re
                .captures(&m.description_block)
                .map(|c| c[1].trim().to_string())
                .or_else(|| {
                    inline_desc_re
                        .captures(&m.description_block)
                        .map(|c| c[1].trim().trim_matches('"').trim_matches('\'').to_string())
                })
                .unwrap_or_default();

            if !scd_re.is_match(&desc_text) {
                continue; // missing SCD entirely — already covered by scd_type
            }
            // Word count after stripping the SCD phrase — must have substantive content beyond it.
            let stripped = scd_re.replace_all(&desc_text, "").to_string();
            let words = stripped.split_whitespace().count();
            if words < 8 {
                v.push(Violation::mechanical(
                    "scd_quality",
                    "Dimension SCD type description must explain the implication for the dimension",
                    "minor",
                    &r,
                    &format!(
                        "dim model '{}' description names an SCD type but adds <8 words of context",
                        m.name
                    ),
                    "Expand the description to explain what the SCD type means for this dimension",
                ));
            }
        }
    }

    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_column_identifies_ids_by_name() {
        assert_eq!(classify_column("id", None), Some(0));
        assert_eq!(classify_column("order_id", None), Some(0));
        assert_eq!(classify_column("account_key", None), Some(0));
        // Even if data_type would say string, an _id wins
        assert_eq!(classify_column("customer_id", Some("varchar")), Some(0));
    }

    #[test]
    fn classify_column_uses_data_type_for_non_ids() {
        assert_eq!(classify_column("customer_name", Some("varchar")), Some(1));
        assert_eq!(classify_column("amount", Some("numeric(18,4)")), Some(2));
        assert_eq!(classify_column("is_active", Some("boolean")), Some(3));
        assert_eq!(classify_column("created_date", Some("date")), Some(4));
        assert_eq!(classify_column("updated_at", Some("timestamp")), Some(5));
        // timestamp must beat date even though "datetime" has "date" in it
        assert_eq!(classify_column("ts", Some("datetime")), Some(5));
        // unknown data_type, non-id name → None
        assert_eq!(classify_column("blob_field", Some("bytea")), None);
        assert_eq!(classify_column("name", None), None);
    }

    #[test]
    fn abbreviation_detector_finds_common_short_forms() {
        let abbrevs = abbreviation_set();
        let prefixes = folder_prefix_set();
        let allow = allow_short();
        assert_eq!(
            find_abbrev_in_identifier("emp_id", &abbrevs, &prefixes, &allow),
            Some("emp".to_string())
        );
        assert_eq!(
            find_abbrev_in_identifier("cust_acct_num", &abbrevs, &prefixes, &allow),
            Some("cust".to_string())
        );
        // Folder prefixes ok as first token
        assert_eq!(
            find_abbrev_in_identifier("stg_orders", &abbrevs, &prefixes, &allow),
            None
        );
        // Allowed short tokens
        assert_eq!(
            find_abbrev_in_identifier("user_id", &abbrevs, &prefixes, &allow),
            None
        );
        assert_eq!(
            find_abbrev_in_identifier("source_url", &abbrevs, &prefixes, &allow),
            None
        );
        // Full word, not an abbreviation
        assert_eq!(
            find_abbrev_in_identifier("customer_name", &abbrevs, &prefixes, &allow),
            None
        );
    }

    #[test]
    fn extract_models_parses_typed_columns() {
        let yaml = r#"version: 2

models:
  - name: stg_orders
    description: Test
    columns:
      - name: order_id
        data_type: bigint
      - name: customer_name
        data_type: varchar
      - name: amount
        data_type: numeric
"#;
        let models = extract_models(yaml);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "stg_orders");
        assert_eq!(models[0].columns.len(), 3);
        assert_eq!(models[0].columns[0].name, "order_id");
        assert_eq!(models[0].columns[0].data_type.as_deref(), Some("bigint"));
        assert_eq!(models[0].columns[2].data_type.as_deref(), Some("numeric"));
    }
}
