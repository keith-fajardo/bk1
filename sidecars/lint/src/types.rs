use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Violation {
    pub code: String,
    pub rule: String,
    pub severity: String,
    pub file: String,
    pub evidence: String,
    pub suggested_fix: String,
    pub check_type: String,
}

impl Violation {
    pub fn mechanical(code: &str, rule: &str, severity: &str, file: &str, evidence: &str, fix: &str) -> Self {
        Self {
            code: code.to_string(),
            rule: rule.to_string(),
            severity: severity.to_string(),
            file: file.to_string(),
            evidence: evidence.to_string(),
            suggested_fix: fix.to_string(),
            check_type: "mechanical".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClaudeMdInfo {
    pub found: bool,
    pub staging_double_sep: bool,
    pub has_staging: bool,
    pub has_intermediate: bool,
    pub has_dim: bool,
    pub has_fct: bool,
    pub has_bridge: bool,
    pub has_rpt: bool,
    pub has_lkp: bool,
    pub requires_pipe_scalar: bool,
    pub staging_folder: String,
    pub intermediate_folder: String,
    pub marts_folder: String,
    pub sources_folder: String,
}

impl Default for ClaudeMdInfo {
    fn default() -> Self {
        Self {
            found: false,
            staging_double_sep: false,
            has_staging: false,
            has_intermediate: false,
            has_dim: false,
            has_fct: false,
            has_bridge: false,
            has_rpt: false,
            has_lkp: false,
            requires_pipe_scalar: false,
            staging_folder: "models/staging".to_string(),
            intermediate_folder: "models/intermediate".to_string(),
            marts_folder: "models/marts".to_string(),
            sources_folder: "models/sources".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Summary {
    pub total: usize,
    pub by_severity: HashMap<String, usize>,
    pub by_rule: HashMap<String, usize>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LintOutput {
    pub generated_at: String,
    pub project_name: String,
    pub violations: Vec<Violation>,
    pub select_star_candidates: Vec<String>,
    pub semantic_review_queue: Vec<String>,
    pub summary: Summary,
}
