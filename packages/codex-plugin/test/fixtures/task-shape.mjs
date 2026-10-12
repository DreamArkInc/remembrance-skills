// Shared fixtures for the task-shape tests of every prompt adapter (owner
// decision 34C): prompts the keyword triggers search and prompts only the
// task-shape default searches, empty registry answers, and the no-match block
// an empty task-shape search leaves out. Every prompt is synthetic.
import { withoutResults } from "./search-hygiene.mjs";
import { templateProposal } from "./skill-idea-proposals.mjs";

// Turns the task-shape default off, so only the keyword triggers search.
export const KEYWORDS_ONLY = Object.freeze({
  REMEMBRANCE_AUTO_QUERY_TASK_SHAPE: "0",
});

// A keyword trigger searches the first of each pair (ui_or_dashboard_work,
// external_service); only the task-shape default searches the second. The
// second pair carries a user correction each.
export const KEYWORD_PROMPT =
  "Please look at the dashboards for this project today.";
export const TASK_SHAPE_PROMPT =
  "Please summarize these meeting notes and list the open questions for me.";
export const KEYWORD_CORRECTION =
  "You broke the build: the Stripe webhook deploy on Vercel fails again.";
export const TASK_SHAPE_CORRECTION =
  "You broke it again: the summary of these notes lists the wrong owners.";

export const EMPTY_QUERY_ID = "rq_task_shape_empty";

// A candidate every prompt adapter drops: its stated applicability does not
// fit the task.
const UNLIKELY_CANDIDATE = Object.freeze({
  slug: "notes-digest",
  source: "public",
  description: "Digest for release notes.",
  result_id: "qres_notes_digest",
  match_tier: "possible",
  match_reason: "Topic match, but stated applicability does not fit this task",
  why_matched: { lexical_signal: "strong", semantic_signal: "none" },
  applicability: { fit: "unlikely", scope: "corner_case" },
});

// A registry answer with nothing to show, carrying the receipt, the feedback
// offer and a contribution directive as a real answer does. Raw-empty answers
// carry the server's no_results block; when every candidate is one the
// adapter drops (`filtered`), the server sends none.
export function emptyBody(access, preferences, { filtered = false } = {}) {
  return {
    query_id: EMPTY_QUERY_ID,
    query_feedback: { available: true, query_id: EMPTY_QUERY_ID },
    skill_access: access,
    effective_preferences: preferences,
    skills: filtered ? [UNLIKELY_CANDIDATE] : [],
    resources: [],
    ...(filtered
      ? {}
      : {
          no_results: {
            reason: "no_matching_skills_or_resources",
            propose_skill_idea_payload: templateProposal(EMPTY_QUERY_ID),
          },
        }),
    contribution_directive: {
      message: "Propose a skill idea only for a reusable workflow you built.",
    },
  };
}

// A query context without its no-match block: the trigger line, the receipt,
// the no-match offer, the contribution directive and the empty-result advice
// (`adviceLines`, the lines emptyQueryContext adds after its trigger line).
// Null when only the header would remain.
export function withoutNoMatchBlock(context, adviceLines) {
  const kept = withoutResults(context);
  if (kept === null) return null;
  const lines = kept.split("\n").filter((line) => !adviceLines.includes(line));
  return lines.length === 1 && lines[0] === "Remembrance auto-query context:"
    ? null
    : lines.join("\n");
}
