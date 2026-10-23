import { createHash } from "node:crypto";

const MAX_COMMAND_BYTES = 64 * 1024;
const COMMAND_HEADER = /^\/remembrance-context psd_[A-Za-z0-9_-]{8,96}\r?\n/u;
const REVOKE_COMMAND = /^\/remembrance-context-revoke psd_[A-Za-z0-9_-]{8,96}(?:\r?\n)?$/u;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const TELEGRAM_ID = /^[1-9][0-9]{0,19}$/u;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactToken = (value, pattern) => typeof value === "string" && value.trim() === value && pattern.test(value);
const validSession = value => exactToken(value, SESSION) && !/^(?:unknown|null|undefined)$/iu.test(value);

/** Qualify only a trusted reply_dispatch callback's ordinary Telegram DM text.
 * The callback must supply cfg from its second, host-owned hook argument:
 * nativeContextAuthorityEvent({ ...event, cfg: hookContext.cfg }, dependencies).
 * resolveCommandAuthorization comes from openclaw/plugin-sdk/command-auth;
 * it is a trusted bootstrap dependency, never an MCP argument or permission flag.
 *
 * RawBody is canonical host text: OpenClaw may already normalize newlines,
 * system tags and provider text. Preserve the complete observed string; never
 * substitute normalized command arguments or infer text from conversation history.
 * This is native-event consistency, not cryptographic human/same-UID attestation.
 * The returned object belongs only on the private native-context CLI bridge.
 */
export async function nativeContextAuthorityEvent(event, { resolveCommandAuthorization } = {}) {
  try {
    if (!record(event) || !record(event.ctx) || !record(event.cfg) || typeof resolveCommandAuthorization !== "function") return null;
    // reply_dispatch is absent from the pinned host's conversation-hook gate.
    // Honor that existing opt-in explicitly; never enable it from this adapter.
    if (event.cfg.plugins?.entries?.remembrance?.hooks?.allowConversationAccess !== true) return null;
    const ctx = event.ctx;
    if (ctx.Provider !== "telegram" || ctx.Surface !== "telegram" || ctx.ChatType !== "direct" || ctx.InboundEventKind !== "user_request" || ctx.SenderIsBot !== false) return null;
    if (ctx.OriginatingChannel !== undefined && ctx.OriginatingChannel !== "telegram") return null;
    if (ctx.GatewayClientScopes !== undefined || ctx.CommandTargetSessionKey !== undefined || (ctx.AcpDispatchTailAfterReset !== undefined && ctx.AcpDispatchTailAfterReset !== false) || (event.isTailDispatch !== undefined && event.isTailDispatch !== false)) return null;
    if (ctx.CommandSource !== undefined && ctx.CommandSource !== "text") return null;
    if (ctx.SourceModality !== undefined && ctx.SourceModality !== "text") return null;
    if (typeof ctx.CommandAuthorized !== "boolean") return null;
    if (!exactToken(ctx.SenderId, TELEGRAM_ID) || !exactToken(ctx.MessageSid, TELEGRAM_ID) || !exactToken(ctx.AccountId, ACCOUNT)) return null;
    if (!validSession(ctx.SessionKey) || event.sessionKey !== ctx.SessionKey) return null;
    const session = ctx.SessionId === undefined ? ctx.SessionKey : ctx.SessionId;
    if (!validSession(session)) return null;

    const provenance = ctx.InputProvenance;
    if (provenance !== undefined && (!record(provenance) || provenance.kind !== "external_user" || provenance.sourceSessionKey !== undefined || provenance.originSessionId !== undefined || provenance.sourceTool !== undefined || (provenance.sourceChannel !== undefined && provenance.sourceChannel !== "telegram"))) return null;
    const prompt = ctx.RawBody;
    if (typeof prompt !== "string" || prompt.length > MAX_COMMAND_BYTES || /[\uD800-\uDFFF]/u.test(prompt) || Buffer.byteLength(prompt, "utf8") > MAX_COMMAND_BYTES) return null;
    const header = COMMAND_HEADER.exec(prompt);
    const exactRevoke = REVOKE_COMMAND.exec(prompt)?.[0] === prompt;
    if (!exactRevoke && (!header || prompt.slice(header[0].length).trim().length === 0)) return null;
    // The private CLI owns complete grammar/control validation and inspection.
    const authorization = await resolveCommandAuthorization({ ctx, cfg: event.cfg, commandAuthorized: ctx.CommandAuthorized });
    if (!record(authorization) || authorization.isAuthorizedSender !== true) return null;

    const sourceEventDigest = `sha256:${createHash("sha256").update(JSON.stringify([
      "openclaw-reply-dispatch-canonical-telegram-v1", ctx.AccountId,
      ctx.SenderId, ctx.MessageSid, prompt,
    ])).digest("hex")}`;
    return Object.freeze({
      kind: "qualified_user_prompt",
      producer: "openclaw_reply_dispatch",
      session_id: session,
      prompt,
      project_path: null,
      source_event_digest: sourceEventDigest,
    });
  } catch {
    return null;
  }
}
