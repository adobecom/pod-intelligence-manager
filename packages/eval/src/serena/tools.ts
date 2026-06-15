/**
 * Single source of truth for the Track-A Serena tool gate. The freezer only calls
 * tools in the allowlist; the run-scoped serena_config.yml excludes the denylist so
 * those tools are never even exposed; and the audit asserts neither list drifted.
 *
 * Track A is retrieval-only: no shell, no file writes, no symbolic edits, no
 * refactors, no memory, no onboarding, no raw file/dir/pattern access. Tool names
 * are pinned to the installed Serena (1.5.3 — verified via `serena tools list`).
 * See docs/SERENA_LOCAL_EVAL_PLAN.md.
 */

export const TRACK_A_ALLOWLIST: string[] = [
  "activate_project",
  "get_current_config",
  "initial_instructions",
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_declaration",
  "find_implementations",
  "get_diagnostics_for_file",
];

export const TRACK_A_DENYLIST: string[] = [
  // shell
  "execute_shell_command",
  // file writes / edits
  "create_text_file",
  "replace_content",
  // symbolic edits / refactor
  "insert_after_symbol",
  "insert_before_symbol",
  "replace_symbol_body",
  "rename_symbol",
  "safe_delete_symbol",
  // raw file/dir/pattern access (we want symbolic retrieval only)
  "read_file",
  "list_dir",
  "find_file",
  "search_for_pattern",
  // memory
  "write_memory",
  "read_memory",
  "edit_memory",
  "delete_memory",
  "rename_memory",
  "list_memories",
  // onboarding
  "onboarding",
];
