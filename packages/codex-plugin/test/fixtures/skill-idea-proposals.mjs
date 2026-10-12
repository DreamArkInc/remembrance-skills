// Skill-idea proposals as servers have sent them with an empty query result.

// Until 2026-08-23 (e2edee36) the server titled the proposal with the query's
// summary, cut to 77 characters and "...", and described it with the whole
// summary (titleFromSummary, packages/core/src/agent-response.ts). A hook's
// summary is the user's prompt, so such a proposal repeats the prompt.
export function summaryEchoProposal(summary) {
  const trimmed = summary.trim();
  return {
    title: trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trim()}...`,
    description: summary,
    domain_slug: null,
    proposed_metadata: {},
  };
}

// Since then it is a fixed template bound to the query receipt.
export function templateProposal(queryId) {
  return {
    title: "Reusable agent workflow",
    description: "Describe the reusable workflow this agent needed.",
    domain_slug: null,
    proposed_metadata: { origin_query_receipt: queryId },
  };
}

// A query response with no result that carries `proposal`.
export function noResultResponse(queryId, proposal) {
  return {
    query_id: queryId,
    skills: [],
    resources: [],
    no_results: {
      reason: "no_matching_skills_or_resources",
      propose_skill_idea_payload: proposal,
    },
  };
}
