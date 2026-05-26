mod checks;
mod claude_md;
mod types;

use chrono::Utc;
use clap::Parser;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use types::{LintOutput, Summary, Violation};

#[derive(Parser, Debug)]
#[command(name = "bk1-lint", about = "dbt project linter — no Python required")]
struct Args {
    /// Path to dbt project root (default: current directory)
    #[arg(default_value = ".")]
    project_root: String,

    /// Directory to write violations.json into. Defaults to <binary_dir>/data,
    /// which matches where the TS caller reads it from.
    #[arg(long)]
    output_dir: Option<String>,

    /// Re-run all checks, ignoring any cache
    #[arg(long)]
    no_cache: bool,

    /// Skip SQL static analysis
    #[arg(long)]
    no_sql: bool,
}

fn main() {
    let args = Args::parse();

    let project_root = match PathBuf::from(&args.project_root).canonicalize() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Error: cannot resolve project root '{}': {e}", args.project_root);
            std::process::exit(1);
        }
    };

    if !project_root.join("dbt_project.yml").exists() {
        eprintln!(
            "Error: no dbt_project.yml found at {}",
            project_root.display()
        );
        std::process::exit(1);
    }

    let project_name = read_project_name(&project_root);
    let claude_info = claude_md::parse(&project_root);

    // Resolve output base: explicit --output-dir wins; otherwise derive from the
    // binary's own location so the TS caller (which reads from <binary_dir>/data)
    // and the writer stay in sync without hardcoding any user or path.
    let base_dir = match &args.output_dir {
        Some(p) => PathBuf::from(p),
        None => std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|p| p.join("data")))
            .unwrap_or_else(|| PathBuf::from("data")),
    };
    let output_dir = base_dir.join(&project_name);
    fs::create_dir_all(&output_dir).unwrap_or_else(|e| {
        eprintln!("Warning: could not create output dir: {e}");
    });

    let mut violations: Vec<Violation> = Vec::new();

    // Mechanical checks
    violations.extend(checks::naming(&project_root, &claude_info));
    violations.extend(checks::placement(&project_root, &claude_info));
    violations.extend(checks::source_location(&project_root, &claude_info));
    violations.extend(checks::paired_yamls(&project_root));

    let (doc_violations, files_with_desc) = checks::yaml_docs(&project_root, &claude_info);
    violations.extend(doc_violations);

    let (star_violations, mut select_star_candidates) = checks::select_star(&project_root);
    violations.extend(star_violations);

    violations.extend(checks::materialization(&project_root, &claude_info));
    violations.extend(checks::column_ordering(&project_root));
    violations.extend(checks::abbreviation(&project_root));
    violations.extend(checks::scd_quality(&project_root, &claude_info));

    // SQL static analysis (skippable)
    if !args.no_sql {
        violations.extend(checks::sql_static(&project_root));
    }

    // Semantic review queue: YAMLs with real descriptions + select-star files
    let mut semantic_queue: Vec<String> = files_with_desc;
    for f in &select_star_candidates {
        if !semantic_queue.contains(f) {
            semantic_queue.push(f.clone());
        }
    }
    semantic_queue.sort();
    select_star_candidates.sort();

    let output = build_output(&project_name, violations, select_star_candidates, semantic_queue);
    let json = serde_json::to_string_pretty(&output).expect("serialization failed");

    let violations_path = output_dir.join("violations.json");
    fs::write(&violations_path, &json).unwrap_or_else(|e| {
        eprintln!("Warning: could not write violations.json: {e}");
    });
    eprintln!("violations.json written to {}", violations_path.display());
}

fn read_project_name(root: &Path) -> String {
    let text = fs::read_to_string(root.join("dbt_project.yml")).unwrap_or_default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("name:") {
            return rest
                .trim()
                .trim_matches('\'')
                .trim_matches('"')
                .to_string();
        }
    }
    root.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn build_output(
    project_name: &str,
    violations: Vec<Violation>,
    select_star_candidates: Vec<String>,
    semantic_review_queue: Vec<String>,
) -> LintOutput {
    let mut by_severity: HashMap<String, usize> = HashMap::new();
    let mut by_rule: HashMap<String, usize> = HashMap::new();

    for viol in &violations {
        *by_severity.entry(viol.severity.clone()).or_insert(0) += 1;
        *by_rule.entry(viol.code.clone()).or_insert(0) += 1;
    }

    LintOutput {
        generated_at: Utc::now().to_rfc3339(),
        project_name: project_name.to_string(),
        summary: Summary {
            total: violations.len(),
            by_severity,
            by_rule,
        },
        violations,
        select_star_candidates,
        semantic_review_queue,
    }
}
