const PRIVATE_LESSON_SUBMIT_TOOL = "submit_private_lesson_candidate";

export function handlePrivateLessonSubmitApproval(event, options = {}) {
  const toolName = String(event?.toolName ?? event?.tool_name ?? "").toLowerCase();
  if (!toolName.endsWith(PRIVATE_LESSON_SUBMIT_TOOL) || options.approved === true) {
    return undefined;
  }
  return {
    requireApproval: {
      title: "Submit private Remembrance lesson",
      description:
        "Send one already-redacted canonical lesson to this organization's private verification queue. This action cannot publish public content.",
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      timeoutMs: 120_000,
      onResolution(decision) {
        if (decision === "allow-always") options.onAllowAlways?.();
      },
    },
  };
}

export function privateLessonSubmitApproved(api) {
  return asRecord(api?.pluginConfig).privateLessonSubmitApproval === true;
}

export async function persistPrivateLessonSubmitApproval(api) {
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
          privateLessonSubmitApproval: true,
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
