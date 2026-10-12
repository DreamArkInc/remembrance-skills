import { PRIVATE_EGRESS_TOOL_LANES } from "./private-egress-lanes.mjs";

const PRIVATE_LESSON_LANE = "private_lesson";
const PRIVATE_SKILL_LANE = "private_skill";
const PRIVATE_LESSON_SUBMIT_TOOL = "submit_private_lesson_candidate";
const PRIVATE_EGRESS_TOOLS = new Set(Object.keys(PRIVATE_EGRESS_TOOL_LANES));
const PRIVATE_EGRESS_LANES = new Set(Object.values(PRIVATE_EGRESS_TOOL_LANES));

export function handlePrivateLessonSubmitApproval(event, options = {}) {
  const toolName = String(
    event?.toolName ?? event?.tool_name ?? "",
  ).toLowerCase();
  const exactTool = [...PRIVATE_EGRESS_TOOLS].find((candidate) =>
    toolName.endsWith(candidate),
  );
  const lane = exactTool ? PRIVATE_EGRESS_TOOL_LANES[exactTool] : undefined;
  if (
    lane === "conditional_feedback" &&
    !feedbackContainsReusableContent(event)
  ) {
    return undefined;
  }
  const approvedLanes = options.approvedLanes ?? options.approvedTools;
  if (!exactTool || !lane || approvedLanes?.has?.(lane)) {
    return undefined;
  }
  const approval = approvalCopy(lane);
  return {
    requireApproval: {
      title: approval.title,
      description: approval.description,
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      timeoutMs: 120_000,
      onResolution(decision) {
        if (decision === "allow-always") options.onAllowAlways?.(lane);
      },
    },
  };
}

function feedbackContainsReusableContent(event) {
  const payload =
    event?.arguments ??
    event?.input ??
    event?.params?.arguments ??
    event?.params;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const lesson = payload.lesson;
  return typeof lesson === "string" && lesson.trim().length > 0;
}

function approvalCopy(lane) {
  if (lane === PRIVATE_SKILL_LANE) {
    return {
      title: "Submit private Remembrance skill",
      description:
        "Send one encrypted complete-skill draft to this organization's private verification and review queue. The submission action cannot publish public content.",
    };
  }
  if (lane === "remembrance_submission") {
    return {
      title: "Submit broad Remembrance content",
      description:
        "Send reusable content through a legacy broad contribution action. Review the complete payload and destination before allowing it.",
    };
  }
  if (lane === "private_skill_proposal") {
    return {
      title: "Propose private Remembrance skill",
      description:
        "Send a complete skill only to this organization's private review queue. This approval does not authorize public-capable candidate actions.",
    };
  }
  if (lane === "skill_candidate") {
    return {
      title: "Propose Remembrance skill candidate",
      description:
        "Send a complete skill candidate whose destination depends on the active credential. Review the payload and resulting visibility before allowing it.",
    };
  }
  if (lane === "skill_suggestion") {
    return {
      title: "Suggest a Remembrance skill change",
      description:
        "Send one proposed change to an existing skill. This approval covers suggestions only.",
    };
  }
  if (lane === "resource_submission") {
    return {
      title: "Submit a Remembrance resource",
      description:
        "Send one reusable resource candidate. This approval does not authorize skill or review submissions.",
    };
  }
  if (lane === "resource_review") {
    return {
      title: "Submit a Remembrance resource review",
      description:
        "Send one resource review with bounded redacted evidence. This approval covers reviews only.",
    };
  }
  if (lane === "conditional_feedback") {
    return {
      title: "Submit reusable feedback content",
      description:
        "Send the reusable lesson attached to this legacy feedback action. Categorical query-fit and post-use feedback do not require this approval.",
    };
  }
  return {
    title: "Submit private Remembrance lesson",
    description:
      "Send one already-redacted canonical lesson to this organization's private verification queue. The submission action cannot publish public content.",
  };
}

export function privateLessonSubmitApproved(api) {
  return privateLearningSubmitApprovals(api).has(PRIVATE_LESSON_LANE);
}

export function privateLearningSubmitApprovals(api) {
  const config = asRecord(api?.pluginConfig);
  const configuredLanes = asRecord(config.privateLearningEgressApprovals);
  const configuredTools = asRecord(config.privateLearningSubmitApprovals);
  const approved = new Set(
    [...PRIVATE_EGRESS_LANES].filter((lane) => configuredLanes[lane] === true),
  );
  for (const [toolName, lane] of Object.entries(PRIVATE_EGRESS_TOOL_LANES)) {
    if (configuredTools[toolName] === true) approved.add(lane);
  }
  if (config.privateLessonSubmitApproval === true) {
    approved.add(PRIVATE_LESSON_LANE);
  }
  return approved;
}

export async function persistPrivateLessonSubmitApproval(api) {
  return persistPrivateLearningSubmitApproval(api, PRIVATE_LESSON_SUBMIT_TOOL);
}

export async function persistPrivateLearningSubmitApproval(api, toolName) {
  const lane = PRIVATE_EGRESS_LANES.has(toolName)
    ? toolName
    : PRIVATE_EGRESS_TOOL_LANES[toolName];
  if (!lane) {
    throw new Error("Unsupported private Remembrance submission action.");
  }
  const mutateConfigFile = api?.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") {
    throw new Error("OpenClaw config mutation is unavailable.");
  }
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const plugins = asRecord(draft.plugins);
      const entries = asRecord(plugins.entries);
      const entry = asRecord(entries.remembrance);
      entries.remembrance = {
        ...entry,
        config: {
          ...asRecord(entry.config),
          privateLearningEgressApprovals: {
            ...asRecord(asRecord(entry.config).privateLearningEgressApprovals),
            [lane]: true,
          },
        },
      };
      plugins.entries = entries;
      draft.plugins = plugins;
    },
  });
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
