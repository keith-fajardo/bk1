use regex::Regex;
use std::fs;
use std::path::Path;

use crate::types::ClaudeMdInfo;

pub fn parse(project_root: &Path) -> ClaudeMdInfo {
    let mut info = ClaudeMdInfo::default();
    let path = project_root.join("CLAUDE.md");
    if !path.exists() {
        return info;
    }
    let text = fs::read_to_string(&path).unwrap_or_default();
    info.found = true;

    // Staging naming pattern
    let stg_double = Regex::new(r"stg_[<({]?source[>)}_]*_{1,2}[<({]?table").unwrap();
    let stg_any = Regex::new(r"\bstg_\b").unwrap();
    if stg_double.is_match(&text) {
        info.staging_double_sep = true;
        info.has_staging = true;
    } else if stg_any.is_match(&text) {
        info.has_staging = true;
    }

    info.has_intermediate = Regex::new(r"\bint_\b").unwrap().is_match(&text);
    info.has_dim    = Regex::new(r"\bdim_\b").unwrap().is_match(&text);
    info.has_fct    = Regex::new(r"\bfct_\b").unwrap().is_match(&text);
    info.has_bridge = Regex::new(r"\bbridge_\b").unwrap().is_match(&text);
    info.has_rpt    = Regex::new(r"\brpt_\b").unwrap().is_match(&text);
    info.has_lkp    = Regex::new(r"\blkp_\b").unwrap().is_match(&text);

    // Pipe scalar requirement
    let pipe1 = Regex::new(r"(?i)\|\s*(block|literal|scalar|for\s+multi)").unwrap();
    let pipe2 = Regex::new(r"(?i)use\s+`?\|`?\s+for\s+(multi|long|description)").unwrap();
    info.requires_pipe_scalar = pipe1.is_match(&text) || pipe2.is_match(&text);

    // Custom folder paths
    if let Some(m) = Regex::new(r"models/staging").unwrap().find(&text) {
        info.staging_folder = m.as_str().trim_end_matches('/').to_string();
    }
    if let Some(m) = Regex::new(r"models/intermediate").unwrap().find(&text) {
        info.intermediate_folder = m.as_str().trim_end_matches('/').to_string();
    }
    if let Some(m) = Regex::new(r"models/marts").unwrap().find(&text) {
        info.marts_folder = m.as_str().trim_end_matches('/').to_string();
    }
    if let Some(m) = Regex::new(r"models/sources").unwrap().find(&text) {
        info.sources_folder = m.as_str().trim_end_matches('/').to_string();
    }

    info
}
