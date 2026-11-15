// Bounded V2 translation prototype for the audited @opencode/plugin 2.3.0 API.
// Factories honor isActive and fetchImpl at post-await effects. Native private
// source authority stays held until a separate admitted-source contract exists.
import { createHash } from "node:crypto";
import { resolveApiAccessSnapshot, sessionSkillsDirective } from "../scripts/hook-core.mjs";

function registryScope() {
  return createHash("sha256").update(JSON.stringify(resolveApiAccessSnapshot())).digest("hex");
}

// Every response branch owns a guarded, zero-prefetch byte stream. Native
// cloning can buffer a tee independently of its source, so clones are wrapped
// recursively and native method results cross the same before/after fence.
// This is a host adapter boundary, not containment of arbitrary same-user JS.
function scopedResponse(response, isActive, inheritedMetadata) {
  const assertActive = () => {
    if (!isActive()) throw new Error("OpenCode session scope changed.");
  };
  const protectStream = body => {
    let reader, released = false;
    const release = () => { if (reader && !released) { reader.releaseLock(); released = true; } };
    return new ReadableStream({
      async pull(controller) {
        try {
          assertActive();
          reader ??= body.getReader();
          const chunk = await reader.read();
          assertActive();
          if (chunk.done) { controller.close(); release(); } else controller.enqueue(chunk.value);
        } catch (error) {
          let failure = error;
          try { assertActive(); } catch (scopeError) { failure = scopeError; }
          controller.error(failure);
          if (reader) void reader.cancel().catch(() => {}).finally(release);
        }
      },
      async cancel(reason) {
        if (released) return;
        reader ??= body.getReader();
        try { await reader.cancel(reason); } finally { release(); }
      },
    }, { highWaterMark: 0 });
  };
  const metadata = inheritedMetadata ?? Object.fromEntries(["url", "redirected", "type"].map(key => [key, response[key]]));
  const initialStream = response.body ? protectStream(response.body) : null;
  const target = new Response(initialStream, { status: response.status, statusText: response.statusText, headers: response.headers });
  const streams = new WeakMap();
  if (initialStream) streams.set(initialStream, initialStream);
  return new Proxy(target, {
    get(native, key) {
      if (Object.hasOwn(metadata, key)) return metadata[key];
      const value = Reflect.get(native, key, native);
      if (key === "body" && value) {
        // clone() replaces the original's body with a native tee branch too.
        // Protect that new branch, including bytes the sibling already read.
        if (!streams.has(value)) streams.set(value, protectStream(value));
        return streams.get(value);
      }
      if (typeof value !== "function") return value;
      return (...args) => {
        assertActive();
        if (key === "clone" && streams.get(native.body)?.locked) throw new TypeError("Response body is locked.");
        const result = Reflect.apply(value, native, args);
        if (result instanceof Response) return scopedResponse(result, isActive, metadata);
        if (result && typeof result.then === "function") return Promise.resolve(result).then(output => {
          assertActive();
          return output;
        }, error => {
          assertActive();
          throw error;
        });
        assertActive();
        return result;
      };
    },
  });
}

export function createOpenCodeV2Setup(createHandlers, { scope = registryScope, sessionSkills = sessionSkillsDirective, log = (level, message) => console.info(`[remembrance:${level}] ${message}`) } = {}) {
  return async function setup(ctx) {
    const controller = new AbortController(), states = new Map(), registrations = [];
    let disposed = false;
    const invalidate = state => { state.closed = true; state.startupSkills = null; state.clear?.(); };
    const active = state => {
      if (disposed || state.closed || states.get(state.id) !== state) return false;
      if (state.scope !== scope()) { invalidate(state); return false; }
      return true;
    };
    const validId = value => typeof value === "string" && value.trim().length > 0;
    function stateFor(id, create = false) {
      if (!validId(id) || disposed) return null;
      let state = states.get(id);
      if (state && !active(state)) {
        state.closed = true;
        if (!create || state.deleted) return null;
        state = null;
      }
      if (!state && create) {
        state = { id, scope: scope(), closed: false, deleted: false, tail: Promise.resolve() };
        states.set(id, state);
      }
      return state;
    }
    async function handlers(state) {
      if (!state.handlers) state.handlers = (async () => {
        const info = await ctx.session.get({ sessionID: state.id });
        if (!active(state) || info?.id !== state.id || !validId(info.location?.directory)) return null;
        const fetchImpl = async (...args) => {
          if (!active(state)) throw new Error("OpenCode session scope is no longer active.");
          const result = await fetch(...args);
          if (!active(state)) throw new Error("OpenCode session scope is no longer active.");
          return scopedResponse(result, () => active(state));
        };
        state.startupSkills = await sessionSkills({ source: "startup", nativeSessionId: state.id, fetchImpl }, process.env);
        if (!active(state)) return null;
        const client = { app: { log: async ({ body }) => { if (active(state)) log(body.level, body.message); } } };
        const hooks = await createHandlers({
          directory: info.location.directory, client, isActive: () => active(state),
          nativeContextAuthority: false,
          onInvalidate: clear => { state.clear = clear; if (!active(state)) clear(); },
          fetchImpl,
        });
        if (!active(state)) return null;
        await hooks.event?.({ event: { type: "session.created", properties: { info: { id: state.id, parentID: info.parentID } } } });
        return active(state) ? hooks : null;
      })();
      const pending = state.handlers;
      try {
        const result = await pending;
        if (!result && active(state) && state.handlers === pending) state.handlers = null;
        return result;
      } catch (error) {
        if (active(state) && state.handlers === pending) state.handlers = null;
        throw error;
      }
    }
    function enqueue(state, run) {
      if (!state) return Promise.resolve();
      const task = state.tail.then(async () => {
        if (!active(state)) return;
        const hooks = await handlers(state);
        if (hooks && active(state)) await run(hooks, state);
      });
      // A failed optional hook must not break the host or poison later turns.
      state.tail = task.catch(() => {});
      return state.tail;
    }
    async function cleanup() {
      disposed = true;
      for (const state of states.values()) invalidate(state);
      states.clear();
      controller.abort();
    }
    try {
      registrations.push(await ctx.session.hook("prompt", event => {
        if (event.metadata?.synthetic === true || event.metadata?.ignored === true) return;
        const state = stateFor(event.sessionID, true);
        return enqueue(state, async hooks => {
          if (typeof event.prompt?.text !== "string") return;
          await hooks["chat.message"]?.(
            { sessionID: event.sessionID, messageID: event.messageID },
            { message: { id: event.messageID, role: "user", sessionID: event.sessionID }, parts: [{ type: "text", text: event.prompt.text }] },
          );
        });
      }));
      for (const kind of ["context", "title", "generate", "compaction"]) {
        registrations.push(await ctx.session.hook(kind, event => enqueue(stateFor(event.sessionID), async (hooks, state) => {
          if (!Array.isArray(event.system)) return;
          const output = { system: [] };
          await hooks["experimental.chat.system.transform"]?.({ sessionID: event.sessionID }, output);
          if (!active(state)) return;
          event.system.push(...[state.startupSkills, ...output.system].filter(text => typeof text === "string" && text.trim()).map(text => ({ type: "text", text })));
        })));
      }
      registrations.push(await ctx.session.hook("experimental.idle", event => enqueue(stateFor(event.sessionID), async hooks => {
        await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: event.sessionID } } });
      })));
      registrations.push(await ctx.tool.hook("execute.after", event => enqueue(stateFor(event.sessionID), async hooks => {
        if (!["completed", "error"].includes(event.status)) return;
        await hooks["tool.execute.after"]?.(
          { sessionID: event.sessionID, messageID: event.messageID, callID: event.id, tool: event.tool, args: event.input },
          event.status === "completed" ? event.result : { isError: true, error: event.error },
        );
      })));
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (disposed) break;
            const id = event.data?.sessionID;
            if (!validId(id)) continue;
            if (event.type === "session.deleted") {
              const state = states.get(id);
              if (state) { invalidate(state); state.deleted = true; }
              continue;
            }
            if (event.type === "session.created") { void enqueue(stateFor(id, true), async () => {}); continue; }
            if (["session.execution.failed", "session.execution.interrupted"].includes(event.type)) {
              const state = states.get(id);
              if (state && active(state)) {
                invalidate(state);
                try { log("info", "OpenCode execution ended without successful completion. Remembrance retains pending work and refreshes guidance on the next prompt."); } catch {}
              }
              continue;
            }
            // Message/part events are intentionally not interpreted as native
            // prompts; the V2 prompt callback owns this admission boundary.
            if (event.type !== "permission.replied") continue;
            void enqueue(stateFor(id), async hooks => {
              await hooks.event?.({ event: { type: event.type, properties: { ...event.data } } });
            });
          }
        } catch {
          // Abort and host event-stream failures are advisory, content-free.
        }
      })();
    } catch (error) {
      await cleanup();
      await Promise.allSettled(registrations.map(registration => registration.dispose()));
      throw error;
    }
    return cleanup;
  };
}
