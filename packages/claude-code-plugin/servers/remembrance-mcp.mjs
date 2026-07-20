#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../core/src/ids.ts
import { createHash, randomUUID } from "node:crypto";
function canonicalJson(value) {
  return JSON.stringify(sortForHash(value));
}
function hashValue(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function sortForHash(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortForHash(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortForHash(value[key]);
      return acc;
    }, {});
  }
  return value;
}

// ../core/src/attestation.ts
function defaultAgentKeyIdForPublicKey(publicKey) {
  return `tofu_${hashValue(publicKey).replace(/^sha256:/, "").slice(0, 24)}`;
}
function buildAgentKeyRegistrationSigningPayload(args) {
  const signedAt = args.signedAt instanceof Date ? args.signedAt.toISOString() : args.signedAt;
  return canonicalJson({
    version: "v1",
    purpose: "remembrance-agent-key-registration",
    provider: args.provider,
    key_id: args.keyId ?? defaultAgentKeyIdForPublicKey(args.publicKey),
    public_key_hash: hashValue(args.publicKey),
    subject: args.subject ?? null,
    signed_at: signedAt
  });
}
function attestationEvidenceHashForRemembrance(payload) {
  return hashValue(
    canonicalJson({
      source_type: "remembrance",
      schema_version: payload.schema_version,
      type: payload.type,
      agent: payload.agent ? {
        id: payload.agent.id ?? null,
        agent_id: payload.agent.agent_id ?? null,
        provider: payload.agent.provider ?? null
      } : null,
      task: {
        domain: payload.task.domain,
        summary: payload.task.summary,
        task_fingerprint: payload.task.task_fingerprint ?? null,
        privacy: payload.task.privacy
      },
      skill: payload.skill ?? null,
      resource: payload.resource ?? null,
      outcome: payload.outcome,
      lesson: payload.lesson,
      suggested_update: payload.suggested_update,
      evidence: {
        trace_hash: payload.evidence.trace_hash ?? null,
        artifact_hashes: payload.evidence.artifact_hashes ?? []
      }
    })
  );
}

// ../core/src/agent-guidance.ts
var REMEMBRANCE_QUERY_TOOL_DESCRIPTION = "Call before non-trivial service, API, tool, library, workflow, UI, review, test, security, or deployment work to find relevant Remembrance skills and resources. For short context-dependent follow-ups, infer the concrete task from the full conversation, preserve any plugin-supplied client_context.directive_id/runtime/trigger_reason, and query anyway. Compare each candidate's bounded why_matched evidence and applicability conditions before opening it; discard stated unlikely or corner-case mismatches. High matches should be fetched before custom work; possible and exploratory matches remain optional. Do not use for broad web search or one-off facts.";
var REMEMBRANCE_MCP_SERVER_INSTRUCTIONS = "Remembrance is shared operational memory for agents. When the user explicitly names an authorized Remembrance skill or supplies a remembrance://skills/{slug} URI, resolve ambiguous names with list_skills using its normalized slug-prefix filter, then call invoke_skill with an exact returned slug. Never guess a slug. list_skills is catalog resolution, not relevance search; use query_skills when the user wants relevant candidates rather than a known selection. invoke_skill rechecks authorization and organization policy, resolves the current reviewed version, and returns the only full instruction body. Catalog listings and MCP resource reads are lightweight handles, not skill use. Do not run query_skills merely to rediscover that explicit selection, and do not submit query-fit feedback for it. After meaningful direct use, follow the returned task-outcome and post-use feedback instructions once. BEFORE non-trivial service/API/tool/library/workflow/UI/review/test/security/deployment work, call query_skills to reuse proven skills and resources instead of rediscovering them. A local repository change still qualifies when it involves a reusable workflow or lesson; skip only genuinely trivial throwaway edits and one-off facts. For short follow-ups such as 'fix these issues', 'continue', or 'try again', infer the concrete task, domain, and constraints from the full conversation and still call query_skills; do not wait for the current prompt to repeat trigger keywords. Treat match_tier as a decision aid, then inspect why_matched and applicability before opening a result. These fields show bounded matched terms/capabilities, satisfied and missed constraints, qualitative lexical/semantic evidence, declared scope, use conditions, and exclusions without exposing unstable raw ranking scores. Discard an unlikely or irrelevant corner-case result and report fit: poor; do not force its use. For a remaining high match, call get_skill or get_resource before custom work and pass the returned query_id/result_id so the surfaced-to-fetch funnel closes; possible and exploratory matches are optional. The response also includes approximate context tokens, verified uses, risk, tags, permissions, dependencies, and contraindications so you can weigh the detour safely. Honor query_skills.skill_access on every response. When policy is org_only, use only returned organization skills and never substitute bundled or live public skill references; if an organization key is configured and the query is unavailable, fail closed because the policy cannot be confirmed. AFTER query_skills, call submit_query_feedback once with one complete set of explicit good/partial/poor judgments using the returned query_id and result_id values; leave unrated results neutral, and remember that a poor query match is not the same as a globally bad skill. Reuse the same organization or anonymous auth scope as the query. AFTER you actually use a skill or resource, close the post-use loop with submit_feedback (useful true/false plus a one-line lesson and the originating query_id/result_id; it returns a ready submit_remembrance payload), then submit_remembrance if the lesson is reusable, or propose_skill_idea only if nothing fit and you built a new workflow. When delegating, pass the selected slug, exact version, query_id, and result_id to the subagent; it should invoke/fetch that result or run its own full-context query. The parent reports the terminal outcome unless the subagent creates its own invocation. Before finishing any reusable task, self-check for a missed query. If you catch your own mistake, the user catches one, CI/deploy fails, a security issue appears, or you fix a release/versioning miss, submit a failure_report remembrance even if no skill was used; raw MCP clients have no plugin Stop hook to remind you later. Attach evidence (reproduction detail, artifact hashes, or an attestation); evidence-less public reports wait in unverified intake until corroborated. Redact secrets, private URLs, credentials, raw logs, and proprietary content; submit summaries and hashes, not raw traces.";

// ../core/src/redaction.ts
var SECRET_PATTERN_SPECS = [
  [
    "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    "g"
  ],
  ["\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\\b", "g"],
  ["\\bsk-proj-[A-Za-z0-9_-]{12,}\\b", "g"],
  ["\\bsk-[A-Za-z0-9_-]{20,}\\b", "g"],
  ["\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", "g"],
  ["\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b", "g"],
  ["\\bxox[abp]-[A-Za-z0-9-]{20,}\\b", "g"],
  ["\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b", "g"],
  [
    `\\b(?:aws_secret_access_key|aws_secret_key|secret_access_key)\\s*[:=]\\s*["']?[A-Za-z0-9/+=]{32,}["']?`,
    "gi"
  ],
  ["\\bya29\\.[A-Za-z0-9_-]{20,}\\b", "g"],
  ["\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b", "g"],
  ["\\bBearer\\s+[A-Za-z0-9._~+/=-]{12,}\\b", "gi"],
  [`\\bhttps?:\\/\\/[^:\\/\\s"'<>]+:[^@\\/\\s"'<>]+@[^\\s"'<>]+`, "gi"],
  [`\\bmongodb(?:\\+srv)?:\\/\\/[^\\s"'<>]+`, "gi"],
  [`\\bredis(?:s)?:\\/\\/[^\\s"'<>]+`, "gi"],
  [`\\bpostgres(?:ql)?:\\/\\/[^\\s"'<>]+`, "gi"],
  ["\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "g"],
  [
    `\\bhttps?:\\/\\/[^\\s"'<>]*\\b(?:token|key|secret|password)=[^\\s"'<>]+`,
    "gi"
  ],
  [
    `\\bhttps?:\\/\\/[^\\/\\s"'<>]*(?:\\.internal|\\.local|\\.corp|\\.onion)(?::\\d+)?[^\\s"'<>]*`,
    "gi"
  ]
];
var SECRET_PATTERNS = SECRET_PATTERN_SPECS.map(
  ([source, flags]) => new RegExp(source, flags)
);

// ../../node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// ../../node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// ../core/src/skill-catalog.ts
var REMEMBRANCE_SKILL_RESOURCE_URI_TEMPLATE = "remembrance://skills/{slug}";
function normalizeSkillCatalogPrefix(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function remembranceSkillResourceUri(slug) {
  return `remembrance://skills/${encodeURIComponent(slug)}`;
}
function parseRemembranceSkillResourceUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Invalid Remembrance skill resource URI.");
  }
  if (parsed.protocol !== "remembrance:" || parsed.hostname !== "skills" || parsed.search || parsed.hash) {
    throw new Error("Invalid Remembrance skill resource URI.");
  }
  const encodedSlug = parsed.pathname.replace(/^\/+/, "");
  if (!encodedSlug || encodedSlug.includes("/")) {
    throw new Error("Invalid Remembrance skill resource URI.");
  }
  let slug;
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    throw new Error("Invalid Remembrance skill resource URI.");
  }
  if (!slug || remembranceSkillResourceUri(slug) !== uri) {
    throw new Error("Invalid Remembrance skill resource URI.");
  }
  return slug;
}
function remembranceSkillResourceHandle(entry) {
  return JSON.stringify(
    {
      kind: "remembrance_skill_selection_handle",
      action: "invoke_skill",
      slug: entry.slug,
      name: entry.name,
      summary: entry.summary,
      version: entry.version,
      source: entry.source,
      visibility: entry.visibility,
      risk_level: entry.risk_level,
      domains: entry.domains,
      tags: entry.tags,
      instruction: "Call invoke_skill with this exact slug to recheck authorization and load the current active reviewed version. Do not infer private instructions from this handle."
    },
    null,
    2
  );
}

// ../core/src/schemas.ts
var DEFAULT_MUTATION_BODY_LIMIT_BYTES = 256 * 1024;
var MAX_SHORT_TEXT_LENGTH = 512;
var MAX_LONG_TEXT_LENGTH = 12e3;
var MAX_JSON_FIELD_BYTES = 64 * 1024;
function boundedString(max) {
  return external_exports.string().min(1).max(max);
}
function finiteNumber() {
  return external_exports.number().finite();
}
function canonicalStringArray(values) {
  return [...values].sort().join("\0");
}
function boundedJsonRecord(maxBytes = MAX_JSON_FIELD_BYTES) {
  return external_exports.record(external_exports.unknown()).superRefine((value, ctx) => {
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).length;
    if (byteLength > maxBytes) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.too_big,
        maximum: maxBytes,
        type: "array",
        inclusive: true,
        message: `JSON object must be ${maxBytes} bytes or smaller`
      });
    }
  });
}
var agentProviderSchema = external_exports.enum([
  "codex",
  "cursor",
  "claude",
  "openclaw",
  "generic",
  "other"
]);
var attestationProviderSchema = external_exports.enum([
  "claude_code",
  "codex",
  "cursor",
  "org_api_key",
  "other"
]);
var attestationStatusSchema = external_exports.enum([
  "none",
  "claimed",
  "verified",
  "rejected",
  "expired"
]);
var attestationTrustLevelSchema = external_exports.enum([
  "anonymous",
  "claimed",
  "tofu_agent",
  "registered_provider",
  "org_api_key"
]);
var privacySchema = external_exports.enum([
  "public",
  "redacted_public",
  "private",
  "org"
]);
var remembranceTypeSchema = external_exports.enum([
  "skill_use",
  "skill_feedback",
  "skill_idea",
  "resource_review",
  "patch_suggestion",
  "failure_report",
  "eval_result"
]);
var suggestionKindSchema = external_exports.enum([
  "none",
  "amend_skill",
  "new_skill",
  "deprecate_skill",
  "resource_update",
  "metadata_update",
  "score_adjustment"
]);
var skillStatusSchema = external_exports.enum([
  "draft",
  "active",
  "deprecated",
  "quarantined"
]);
var visibilitySchema = external_exports.enum([
  "public",
  "private",
  "unlisted",
  "org",
  "redacted_public"
]);
var enterpriseEncryptionModeSchema = external_exports.enum([
  "none",
  "remembrance_managed",
  "customer_held_external_approver",
  "remembrance_kms_access"
]);
var enterpriseEncryptedPayloadEnvelopeSchema = external_exports.object({
  format: external_exports.enum(["client-envelope-v1", "mongodb-qe-v1"]),
  ciphertext: external_exports.string().min(1).max(DEFAULT_MUTATION_BODY_LIMIT_BYTES),
  key_alias: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  dek_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  content_hash: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  algorithm: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  nonce: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  signature: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
}).strict();
var riskLevelSchema = external_exports.enum(["low", "medium", "high", "unknown"]);
var verificationStatusSchema = external_exports.enum([
  "unverified",
  "pending",
  "verified",
  "rejected",
  "quarantined",
  "needs_review"
]);
var verificationTargetTypeSchema = external_exports.enum([
  "remembrance",
  "resource",
  "skill_idea",
  "suggestion",
  "resource_review",
  "skill_version",
  "verify_request"
]);
var verificationJobStatusSchema = external_exports.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "needs_human",
  "quarantined"
]);
var verifierActionSchema = external_exports.enum([
  "accept",
  "reject",
  "merge",
  "fork",
  "needs_human",
  "quarantine",
  "request_more_evidence",
  "spam"
]);
var resourceKindSchema = external_exports.enum([
  "api_endpoint",
  "mpp_endpoint",
  "mcp_server",
  "web_tool",
  "dataset",
  "docs_site",
  "package",
  "service",
  "other"
]);
var resourceTypeSchema = external_exports.enum([
  "api_endpoint",
  "mpp_endpoint",
  "mpp_site",
  "mcp_server",
  "api",
  "web_site",
  "tool",
  "web_tool",
  "dataset",
  "docs_site",
  "package",
  "service",
  "provider",
  "other"
]);
var resourceVerificationStatusSchema = external_exports.enum([
  "unverified",
  "pending",
  "verified",
  "failed",
  "rejected",
  "quarantined",
  "needs_review"
]);
var resourceStatusSchema = external_exports.enum([
  "pending",
  "active",
  "deprecated",
  "quarantined"
]);
var stringListSchema = external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(80).default([]);
var resourceMetadataSchema = boundedJsonRecord();
var resourceProfileSchema = external_exports.enum(["mpp"]);
var resourceRefSchema = external_exports.object({
  name: boundedString(MAX_SHORT_TEXT_LENGTH),
  kind: resourceKindSchema.optional(),
  type: resourceTypeSchema.optional(),
  url: external_exports.string().url().nullable().optional(),
  description: external_exports.string().max(MAX_LONG_TEXT_LENGTH).optional(),
  domains: stringListSchema,
  capabilities: stringListSchema,
  tags: stringListSchema,
  auth_methods: stringListSchema,
  pricing_model: external_exports.string().max(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  risk_level: riskLevelSchema.optional(),
  verification_status: resourceVerificationStatusSchema.optional(),
  last_verified_at: external_exports.string().datetime().optional(),
  metadata: resourceMetadataSchema.default({})
}).strict().superRefine((resource, ctx) => {
  if (!resource.kind && !resource.type) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "resource.kind or legacy resource.type is required",
      path: ["kind"]
    });
  }
});
var agentSchema = external_exports.object({
  id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  agent_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  name: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  provider: agentProviderSchema.optional(),
  model: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
}).strict();
var queryTaskSchema = external_exports.object({
  domain: boundedString(MAX_SHORT_TEXT_LENGTH),
  summary: boundedString(MAX_LONG_TEXT_LENGTH),
  constraints: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(40).default([])
});
var queryRuntimeSchema = external_exports.enum([
  "codex",
  "claude_code",
  "cursor",
  "openclaw",
  "other",
  "unknown"
]);
var queryDirectiveIdSchema = external_exports.string().regex(/^dir_[A-Za-z0-9_-]{16,80}$/);
var queryClientContextSchema = external_exports.object({
  surface: external_exports.enum(["plugin_hook", "mcp", "rest", "unknown"]).default("unknown"),
  runtime: queryRuntimeSchema.optional(),
  trigger_reason: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  directive_id: queryDirectiveIdSchema.optional()
}).strict();
var reasoningEffortSchema = external_exports.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "unknown"
]);
var economicsTaskStageSchema = external_exports.enum([
  "planning",
  "implementation",
  "debugging",
  "review",
  "testing",
  "deployment",
  "research",
  "other",
  "unknown"
]);
var economicsTaskComplexitySchema = external_exports.enum([
  "low",
  "medium",
  "high",
  "unknown"
]);
var economicsMeasurementCapabilitySchema = external_exports.enum([
  "token_usage",
  "cache_usage",
  "reasoning_tokens",
  "latency",
  "provider_response_id",
  "observed_model_revision"
]);
var boundedScopeCountSchema = external_exports.number().int().min(0).max(1e5);
var economicsContextSchema = external_exports.object({
  runtime: queryRuntimeSchema,
  runtime_version: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  requested_model: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  observed_model_revision: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  reasoning_effort: reasoningEffortSchema.default("unknown"),
  task_stage: economicsTaskStageSchema.default("unknown"),
  complexity: economicsTaskComplexitySchema.default("unknown"),
  scope: external_exports.object({
    file_count: boundedScopeCountSchema.optional(),
    service_count: boundedScopeCountSchema.optional(),
    artifact_count: boundedScopeCountSchema.optional(),
    expected_step_count: boundedScopeCountSchema.optional()
  }).strict().default({}),
  measurement_capabilities: external_exports.array(economicsMeasurementCapabilitySchema).max(economicsMeasurementCapabilitySchema.options.length).default([])
}).strict();
var skillCatalogRequestSchema = external_exports.object({
  q: boundedString(MAX_SHORT_TEXT_LENGTH).transform(normalizeSkillCatalogPrefix).refine((value) => value.length > 0, {
    message: "q must contain at least one letter or digit"
  }).optional(),
  slug: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  cursor: boundedString(MAX_LONG_TEXT_LENGTH).optional(),
  limit: external_exports.number().int().min(1).max(100).default(50)
}).strict().superRefine((value, ctx) => {
  if (value.q && value.slug) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "q and slug cannot be supplied together",
      path: ["slug"]
    });
  }
  if (value.slug && value.cursor) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "slug and cursor cannot be supplied together",
      path: ["cursor"]
    });
  }
});
var skillCatalogEntrySchema = external_exports.object({
  slug: boundedString(MAX_SHORT_TEXT_LENGTH),
  name: boundedString(MAX_SHORT_TEXT_LENGTH),
  summary: external_exports.string().max(MAX_LONG_TEXT_LENGTH),
  version: boundedString(MAX_SHORT_TEXT_LENGTH),
  source: external_exports.enum(["public", "org_overlay"]),
  visibility: visibilitySchema,
  risk_level: riskLevelSchema,
  domains: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(50),
  tags: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(50),
  updated_at: external_exports.string().datetime(),
  resource_uri: boundedString(MAX_LONG_TEXT_LENGTH)
}).strict();
var skillCatalogResponseSchema = external_exports.object({
  skills: external_exports.array(skillCatalogEntrySchema).max(100),
  next_cursor: boundedString(MAX_LONG_TEXT_LENGTH).nullable()
}).strict();
var agentSkillInvocationRequestSchema = external_exports.object({
  slug: boundedString(MAX_SHORT_TEXT_LENGTH),
  agent: agentSchema.optional(),
  task: queryTaskSchema.optional(),
  client_context: queryClientContextSchema.optional(),
  economics_context: economicsContextSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
}).strict();
var agentDirectiveShownEventSchema = external_exports.object({
  event: external_exports.literal("shown"),
  directive_id: queryDirectiveIdSchema,
  surface: external_exports.literal("plugin_hook"),
  runtime: queryRuntimeSchema,
  trigger_reason: boundedString(MAX_SHORT_TEXT_LENGTH)
}).strict();
var agentDirectiveFollowedEventSchema = external_exports.object({
  event: external_exports.literal("followed"),
  directive_id: queryDirectiveIdSchema,
  query_id: boundedString(MAX_SHORT_TEXT_LENGTH)
}).strict();
var agentDirectiveEventRequestSchema = external_exports.discriminatedUnion("event", [
  agentDirectiveShownEventSchema,
  agentDirectiveFollowedEventSchema
]);
var MAX_AGENT_QUERY_RESULTS_PER_TYPE = 20;
var agentQueryRequestSchema = external_exports.object({
  agent: agentSchema.optional(),
  task: queryTaskSchema,
  // Caller-reported analytics only. This never contributes identity, trust,
  // authorization, or ranking weight; transports overwrite `surface` when
  // they know it authoritatively.
  client_context: queryClientContextSchema.optional(),
  // Privacy-bounded value measurement context. Prompts, paths, URLs, source,
  // transcripts, and outputs are intentionally not representable here.
  economics_context: economicsContextSchema.optional(),
  limit: external_exports.number().int().min(1).max(MAX_AGENT_QUERY_RESULTS_PER_TYPE).default(5)
});
var tokenUsageSchema = external_exports.object({
  uncached_input_tokens: external_exports.number().int().min(0).max(1e7),
  cache_read_tokens: external_exports.number().int().min(0).max(1e7).default(0),
  cache_write_tokens: external_exports.number().int().min(0).max(1e7).default(0),
  visible_output_tokens: external_exports.number().int().min(0).max(1e7),
  reasoning_tokens: external_exports.number().int().min(0).max(1e7).default(0)
}).strict();
var economicsMeasurementSourceSchema = external_exports.enum([
  "provider_metered",
  "gateway_metered",
  "plugin_observed",
  "agent_reported",
  "controlled_eval"
]);
var economicsMeteringReferenceSchema = external_exports.object({
  adapter: external_exports.literal("vercel_ai_gateway"),
  generation_ids: external_exports.array(
    boundedString(MAX_SHORT_TEXT_LENGTH).regex(
      /^gen_[A-Za-z0-9]+$/,
      "Vercel generation identifiers must use the gen_ format"
    )
  ).min(1).max(8)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.generation_ids).size !== value.generation_ids.length) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Each generation_id may appear only once",
      path: ["generation_ids"]
    });
  }
});
var taskOutcomeStatusSchema = external_exports.enum(["completed", "abandoned"]);
var economicsSessionProviderSchema = attestationProviderSchema.exclude([
  "org_api_key"
]);
var economicsOutcomeAttestationSchema = external_exports.object({
  version: external_exports.literal("v2").default("v2"),
  provider: economicsSessionProviderSchema,
  challenge_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  key_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  algorithm: external_exports.literal("ed25519").default("ed25519"),
  issued_at: external_exports.string().datetime(),
  expires_at: external_exports.string().datetime(),
  signature: boundedString(MAX_LONG_TEXT_LENGTH)
}).strict();
var agentTaskOutcomeRequestSchema = external_exports.object({
  query_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  result_ids: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(3).default([]),
  estimate_id: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  bundle_id: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  status: taskOutcomeStatusSchema,
  success: external_exports.boolean().nullable().optional(),
  latency_ms: external_exports.number().int().min(0).max(864e5).nullable().optional(),
  token_usage: tokenUsageSchema.nullable().optional(),
  observed_model_revision: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  provider_response_ids: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(8).default([]),
  metering_reference: economicsMeteringReferenceSchema.nullable().optional(),
  measurement_source: economicsMeasurementSourceSchema,
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH),
  attestation: economicsOutcomeAttestationSchema.nullable().optional()
}).strict().superRefine((value, ctx) => {
  if ((value.measurement_source === "provider_metered" || value.measurement_source === "gateway_metered") && value.provider_response_ids.length === 0 && !value.metering_reference) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Metered outcomes require a provider response identifier",
      path: ["provider_response_ids"]
    });
  }
  if (value.metering_reference && value.provider_response_ids.length > 0 && canonicalStringArray(value.metering_reference.generation_ids) !== canonicalStringArray(value.provider_response_ids)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "metering_reference generation_ids must match provider_response_ids when both are supplied",
      path: ["metering_reference", "generation_ids"]
    });
  }
  if (new Set(value.result_ids).size !== value.result_ids.length) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Each result_id may appear only once",
      path: ["result_ids"]
    });
  }
});
var economicsSessionChallengeSchema = external_exports.object({
  action: external_exports.literal("challenge"),
  provider: economicsSessionProviderSchema,
  key_id: boundedString(MAX_SHORT_TEXT_LENGTH)
}).strict();
var economicsSessionExchangeSchema = external_exports.object({
  action: external_exports.literal("exchange"),
  provider: economicsSessionProviderSchema,
  key_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  challenge_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  signature: boundedString(MAX_LONG_TEXT_LENGTH)
}).strict();
var economicsSessionRequestSchema = external_exports.discriminatedUnion("action", [
  economicsSessionChallengeSchema,
  economicsSessionExchangeSchema
]);
var agentPrincipalRegistrationRequestSchema = external_exports.object({
  display_name: boundedString(MAX_SHORT_TEXT_LENGTH),
  provider: agentProviderSchema,
  runtime_version: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  parent_principal_id: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional()
}).strict();
var agentPrincipalUpdateRequestSchema = external_exports.object({
  principal_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  action: external_exports.enum(["deactivate", "reactivate"])
}).strict();
var agentPrincipalKeyBindingRequestSchema = external_exports.object({
  principal_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  api_key_id: boundedString(MAX_SHORT_TEXT_LENGTH)
}).strict();
var remembranceTaskSchema = external_exports.object({
  domain: boundedString(MAX_SHORT_TEXT_LENGTH),
  summary: boundedString(MAX_LONG_TEXT_LENGTH),
  task_fingerprint: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  privacy: privacySchema
});
var outcomeSchema = external_exports.object({
  success: external_exports.boolean().nullable().optional(),
  user_accepted: external_exports.boolean().nullable().optional(),
  usefulness_rating: external_exports.number().int().min(1).max(5).nullable().optional(),
  confidence: finiteNumber().min(0).max(1).nullable().optional(),
  latency_ms: finiteNumber().nonnegative().max(864e5).nullable().optional(),
  cost_usd: finiteNumber().nonnegative().max(1e6).nullable().optional(),
  failure_modes: external_exports.array(external_exports.string().max(MAX_SHORT_TEXT_LENGTH)).max(40).default([])
}).strict();
var remembranceSkillRefSchema = external_exports.object({
  name: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  slug: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  version: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  hash: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
}).strict();
var remembranceResourceRefSchema = external_exports.object({
  name: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  kind: resourceKindSchema.optional(),
  type: resourceTypeSchema.optional(),
  url: external_exports.string().url().optional()
}).strict();
var suggestedUpdateSchema = external_exports.object({
  kind: suggestionKindSchema.default("none"),
  summary: external_exports.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
  diff: external_exports.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional()
}).strict();
var evidenceSchema = external_exports.object({
  trace_hash: external_exports.string().max(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  artifact_hashes: external_exports.array(external_exports.string().max(MAX_SHORT_TEXT_LENGTH)).max(80).default([]),
  attestation: external_exports.object({
    version: external_exports.literal("v2").default("v2"),
    provider: attestationProviderSchema.exclude(["org_api_key"]),
    challenge_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    nonce: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    audience: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    subject: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    subject_hash: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    key_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    algorithm: external_exports.enum(["ed25519"]).default("ed25519"),
    issued_at: external_exports.string().datetime().optional(),
    expires_at: external_exports.string().datetime().optional(),
    evidence_hash: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    signature: boundedString(MAX_LONG_TEXT_LENGTH).optional(),
    token_hash: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
    replay_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
  }).strict().nullable().optional(),
  attestation_token_hash: external_exports.unknown().optional()
}).strict().superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, "attestation_token_hash")) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "attestation_token_hash is no longer accepted; use evidence.attestation with a signed challenge",
      path: ["attestation_token_hash"]
    });
  }
});
var remembrancePayloadSchema = external_exports.object({
  schema_version: external_exports.literal("0.1"),
  type: remembranceTypeSchema,
  agent: agentSchema.optional(),
  task: remembranceTaskSchema,
  skill: remembranceSkillRefSchema.optional(),
  resource: remembranceResourceRefSchema.optional(),
  outcome: outcomeSchema,
  lesson: boundedString(MAX_LONG_TEXT_LENGTH),
  interaction: external_exports.object({
    query_id: boundedString(MAX_SHORT_TEXT_LENGTH),
    result_id: boundedString(MAX_SHORT_TEXT_LENGTH)
  }).strict().optional(),
  enterprise_encryption: enterpriseEncryptedPayloadEnvelopeSchema.optional(),
  suggested_update: suggestedUpdateSchema.default({ kind: "none" }),
  evidence: evidenceSchema.default({ artifact_hashes: [] }),
  // Client-only directive: "sign this with my local TOFU key" (the MCP
  // submit_remembrance tool exposes it, and feedback-next-step tells REST
  // clients to POST the same payload). The server doesn't need it — the actual
  // signature arrives in `evidence.attestation` — but a strict schema would
  // 422 an otherwise-valid submission that forwards this documented field.
  // Accept it here so a forwarding client can't 422; the REST route strips it
  // after parse (before auth/idempotency/storage/verifier) so it is never
  // persisted or hashed.
  verified_attestation: external_exports.boolean().optional()
}).strict();
var skillApplicabilitySchema = external_exports.object({
  scope: external_exports.enum(["general", "specialized", "corner_case"]),
  use_when: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(20).default([]),
  avoid_when: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(20).default([])
}).strict();
var skillMetadataSchema = external_exports.object({
  schema_version: external_exports.literal("0.1"),
  name: boundedString(MAX_SHORT_TEXT_LENGTH),
  slug: boundedString(MAX_SHORT_TEXT_LENGTH),
  description: boundedString(MAX_LONG_TEXT_LENGTH),
  domains: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(40),
  tags: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(80).default([]),
  version: boundedString(MAX_SHORT_TEXT_LENGTH),
  status: skillStatusSchema,
  visibility: visibilitySchema.default("public"),
  providers: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(20).default(["codex", "cursor", "generic"]),
  input_types: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(80).default([]),
  output_types: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(80).default([]),
  capabilities: external_exports.array(boundedString(MAX_SHORT_TEXT_LENGTH)).max(80).default([]),
  dependencies: external_exports.array(boundedJsonValue()).max(80).default([]),
  permissions: external_exports.record(external_exports.boolean()).default({}),
  contraindications: external_exports.array(external_exports.string().max(MAX_LONG_TEXT_LENGTH)).max(80).default([]),
  applicability: skillApplicabilitySchema.optional(),
  feedback_url: external_exports.string().url(),
  install_command: external_exports.string().min(1),
  stats: external_exports.object({
    total_uses: external_exports.number().int().nonnegative().default(0),
    verified_uses: external_exports.number().int().nonnegative().default(0),
    successful_uses: external_exports.number().int().nonnegative().default(0),
    usefulness_index: external_exports.number().min(0).max(100).default(0),
    usefulness_confidence: external_exports.number().min(0).max(1).default(0),
    last_verified_at: external_exports.string().datetime().nullable().default(null)
  })
});
function boundedJsonValue(maxBytes = MAX_JSON_FIELD_BYTES) {
  return external_exports.unknown().superRefine((value, ctx) => {
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).length;
    if (byteLength > maxBytes) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.too_big,
        maximum: maxBytes,
        type: "array",
        inclusive: true,
        message: `JSON value must be ${maxBytes} bytes or smaller`
      });
    }
  });
}
var skillIdeaRequestSchema = external_exports.object({
  agent: agentSchema.optional(),
  title: boundedString(MAX_SHORT_TEXT_LENGTH),
  description: boundedString(MAX_LONG_TEXT_LENGTH),
  domain_slug: boundedString(MAX_SHORT_TEXT_LENGTH).nullable().optional(),
  proposed_skill_md: external_exports.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
  proposed_metadata: boundedJsonRecord().default({}),
  enterprise_encryption: enterpriseEncryptedPayloadEnvelopeSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
});
var suggestionRequestSchema = external_exports.object({
  agent: agentSchema.optional(),
  skill_slug: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  skill_version: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  remembrance_public_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  suggestion_type: suggestionKindSchema.exclude(["none"]),
  summary: boundedString(MAX_LONG_TEXT_LENGTH),
  diff_text: external_exports.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
  payload: boundedJsonRecord().default({}),
  enterprise_encryption: enterpriseEncryptedPayloadEnvelopeSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
});
var resourceReviewRequestSchema = external_exports.object({
  agent: agentSchema.optional(),
  resource: resourceRefSchema,
  review: external_exports.object({
    usefulness_rating: external_exports.number().int().min(1).max(5),
    reliability_rating: external_exports.number().int().min(1).max(5).nullable().optional(),
    auth_friction_rating: external_exports.number().int().min(1).max(5).nullable().optional(),
    cost_predictability_rating: external_exports.number().int().min(1).max(5).nullable().optional(),
    docs_accuracy_rating: external_exports.number().int().min(1).max(5).nullable().optional(),
    prompt_injection_risk: riskLevelSchema.nullable().optional(),
    summary: boundedString(MAX_LONG_TEXT_LENGTH)
  }),
  evidence: evidenceSchema.default({ artifact_hashes: [] }),
  enterprise_encryption: enterpriseEncryptedPayloadEnvelopeSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
});
var resourceSubmissionRequestSchema = external_exports.object({
  agent: agentSchema.optional(),
  resource: resourceRefSchema,
  enterprise_encryption: enterpriseEncryptedPayloadEnvelopeSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional()
});
var resourceVerificationRequestSchema = external_exports.object({
  slug: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  url: external_exports.string().url().optional(),
  profile: resourceProfileSchema.default("mpp")
}).refine((value) => Boolean(value.slug || value.url), {
  message: "slug or url is required",
  path: ["slug"]
});
var verifyRequestSchema = external_exports.object({
  target_type: verificationTargetTypeSchema.optional(),
  target_public_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  attestation_token: boundedString(MAX_LONG_TEXT_LENGTH).optional(),
  evidence_hashes: external_exports.array(external_exports.string().max(MAX_SHORT_TEXT_LENGTH)).max(80).default([]),
  summary: boundedString(MAX_LONG_TEXT_LENGTH).optional()
});
var attestationChallengeRequestSchema = external_exports.object({
  provider: attestationProviderSchema.exclude(["org_api_key"]),
  source_type: external_exports.enum(["remembrance", "resource_review"]),
  agent_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  subject: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  skill_slug: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  resource_slug: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  evidence_hash: boundedString(MAX_SHORT_TEXT_LENGTH),
  expires_in_seconds: external_exports.number().int().min(30).max(600).default(300)
}).superRefine((value, ctx) => {
  if (!value.agent_id) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "agent_id is required for challenge-bound attestations",
      path: ["agent_id"]
    });
  }
  if (value.source_type === "remembrance" && !value.skill_slug) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "skill_slug is required for remembrance attestations",
      path: ["skill_slug"]
    });
  }
  if (value.source_type === "resource_review" && !value.resource_slug) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "resource_slug is required for resource review attestations",
      path: ["resource_slug"]
    });
  }
});
var attestationKeyRegistrationRequestSchema = external_exports.object({
  provider: attestationProviderSchema.exclude(["org_api_key"]),
  key_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  public_key: boundedString(MAX_LONG_TEXT_LENGTH),
  subject: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  agent: agentSchema.optional(),
  proof: external_exports.object({
    algorithm: external_exports.enum(["ed25519"]).default("ed25519"),
    signed_at: external_exports.string().datetime(),
    signature: boundedString(MAX_LONG_TEXT_LENGTH)
  }),
  metadata: boundedJsonRecord().default({}),
  expires_at: external_exports.string().datetime().nullable().optional()
}).superRefine((value, ctx) => {
  if (!value.subject && !value.agent?.agent_id && !value.agent?.id) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "subject or agent.agent_id is required for TOFU keys",
      path: ["subject"]
    });
  }
});
var agentFeedbackRequestBaseSchema = external_exports.object({
  skill_slug: boundedString(MAX_SHORT_TEXT_LENGTH),
  query_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  result_id: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  useful: external_exports.boolean(),
  lesson: external_exports.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
  rating: external_exports.number().int().min(1).max(5).nullable().optional(),
  agent: agentSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  evidence: evidenceSchema.default({ artifact_hashes: [] })
});
var agentFeedbackRequestSchema = agentFeedbackRequestBaseSchema.superRefine((value, ctx) => {
  if (Boolean(value.query_id) !== Boolean(value.result_id)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "query_id and result_id must be supplied together",
      path: value.query_id ? ["result_id"] : ["query_id"]
    });
  }
});
var queryResultFitSchema = external_exports.enum(["good", "partial", "poor"]);
var queryFeedbackReasonSchema = external_exports.enum([
  "wrong_domain",
  "wrong_task",
  "constraint_conflict",
  "wrong_task_stage",
  "too_generic",
  "too_specific",
  "duplicate",
  "stale_metadata",
  "missing_capability",
  "other"
]);
var agentQueryFeedbackResultSchema = external_exports.object({
  result_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  fit: queryResultFitSchema,
  reasons: external_exports.array(queryFeedbackReasonSchema).max(8).default([]),
  note: external_exports.string().max(1e3).transform((value) => value.trim()).nullable().optional()
}).strict().superRefine((value, ctx) => {
  if (value.fit === "poor" && value.reasons.length === 0) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Poor matches require at least one reason",
      path: ["reasons"]
    });
  }
});
var agentQueryFeedbackRequestSchema = external_exports.object({
  query_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  overall_fit: external_exports.enum(["good", "partial", "none"]),
  results: external_exports.array(agentQueryFeedbackResultSchema).max(20).default([]),
  missing_capability: external_exports.string().max(2e3).transform((value) => value.trim()).nullable().optional(),
  agent: agentSchema.optional(),
  idempotency_key: boundedString(MAX_SHORT_TEXT_LENGTH).optional(),
  evidence: evidenceSchema.default({ artifact_hashes: [] })
}).strict().superRefine((value, ctx) => {
  if (value.results.length === 0 && value.overall_fit !== "none") {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "At least one result verdict is required unless nothing fit",
      path: ["results"]
    });
  }
  const resultIds = value.results.map((result) => result.result_id);
  if (new Set(resultIds).size !== resultIds.length) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Each result_id may appear only once",
      path: ["results"]
    });
  }
  if (value.overall_fit === "none" && value.results.some((result) => result.fit !== "poor")) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "When nothing fit, every rated result must be marked poor",
      path: ["results"]
    });
  }
});
var adminReviewActionValueSchema = external_exports.enum([
  ...verifierActionSchema.options,
  "delete"
]);
var adminReviewActionSchema = external_exports.object({
  job_id: boundedString(MAX_SHORT_TEXT_LENGTH),
  action: adminReviewActionValueSchema,
  note: external_exports.string().max(MAX_LONG_TEXT_LENGTH).transform((value) => value.trim()).optional()
});

// ../core/src/seed.ts
var siteUrl = "https://remembrance.dev";
var feedbackUrl = `${siteUrl}/api/v1/agent/remembrances`;

// ../core/src/skill-value.ts
import {
  createPublicKey,
  verify
} from "node:crypto";
var tokenSavingsRangeSchema = external_exports.object({
  low: external_exports.number().int(),
  median: external_exports.number().int(),
  high: external_exports.number().int()
}).strict();
var valueProofScopeSchema = external_exports.object({
  file_count: external_exports.number().int().min(0).max(1e5).optional(),
  service_count: external_exports.number().int().min(0).max(1e5).optional(),
  artifact_count: external_exports.number().int().min(0).max(1e5).optional(),
  expected_step_count: external_exports.number().int().min(0).max(1e5).optional()
}).strict();
var valueProofKeyIdSchema = external_exports.string().min(1).max(512);
var VALUE_PROOF_ISSUED_AT_CLOCK_SKEW_MS = 5 * 60 * 1e3;
var publicValueProofPayloadSchema = external_exports.object({
  proof_id: external_exports.string().min(1).max(512),
  proof_scope: external_exports.enum(["public", "organization"]),
  target_version_ids: external_exports.array(external_exports.string().min(1).max(512)).min(1).max(3),
  target_slugs: external_exports.array(external_exports.string().min(1).max(512)).min(1).max(3),
  runtime: external_exports.string().min(1).max(512),
  runtime_version: external_exports.string().min(1).max(512),
  requested_model: external_exports.string().min(1).max(512),
  model_revision: external_exports.string().min(1).max(512),
  reasoning_effort: external_exports.string().min(1).max(128),
  task_domain: external_exports.string().min(1).max(512),
  task_stage: economicsTaskStageSchema,
  complexity: economicsTaskComplexitySchema,
  scope: valueProofScopeSchema,
  context_tokens: external_exports.number().int().nonnegative(),
  estimated_saved: tokenSavingsRangeSchema,
  confidence_interval_90: external_exports.object({ lower: external_exports.number().int(), upper: external_exports.number().int() }).strict(),
  success_rate_delta: external_exports.number().finite().nullable(),
  latency_delta_ms: external_exports.number().finite().nullable(),
  evidence_count: external_exports.number().int().nonnegative(),
  scenario_count: external_exports.number().int().nonnegative(),
  proof_grade: external_exports.enum(["A", "B"]),
  estimator_version: external_exports.string().min(1).max(512),
  methodology: external_exports.enum(["paired_metered", "observed_metered"]),
  evidence_digest: external_exports.string().min(1).max(512),
  issued_at: external_exports.string().datetime(),
  calibrated_at: external_exports.string().datetime(),
  expires_at: external_exports.string().datetime()
}).strict().superRefine((payload, context) => {
  if (payload.target_version_ids.length !== payload.target_slugs.length) {
    context.addIssue({
      code: "custom",
      message: "Value proof targets are inconsistent.",
      path: ["target_slugs"]
    });
  }
  if (payload.estimated_saved.low > payload.estimated_saved.median || payload.estimated_saved.median > payload.estimated_saved.high) {
    context.addIssue({
      code: "custom",
      message: "Value proof savings range is not ordered.",
      path: ["estimated_saved"]
    });
  }
  if (payload.confidence_interval_90.lower > payload.confidence_interval_90.upper) {
    context.addIssue({
      code: "custom",
      message: "Value proof confidence interval is not ordered.",
      path: ["confidence_interval_90"]
    });
  }
  const calibratedAt = Date.parse(payload.calibrated_at);
  const issuedAt = Date.parse(payload.issued_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (calibratedAt > issuedAt || issuedAt >= expiresAt) {
    context.addIssue({
      code: "custom",
      message: "Value proof timestamps are inconsistent.",
      path: ["issued_at"]
    });
  }
});
var signedValueProofResponseSchema = external_exports.object({
  payload: publicValueProofPayloadSchema,
  signature: external_exports.string().regex(/^[A-Za-z0-9_-]+$/).max(512),
  key_id: valueProofKeyIdSchema,
  algorithm: external_exports.literal("Ed25519")
}).strict();
var valueProofPublicKeySchema = external_exports.object({
  kid: valueProofKeyIdSchema,
  kty: external_exports.literal("OKP"),
  crv: external_exports.literal("Ed25519"),
  x: external_exports.string().min(1).max(512),
  alg: external_exports.literal("EdDSA").optional(),
  use: external_exports.literal("sig").optional()
}).passthrough();
var valueProofPublicKeySetSchema = external_exports.object({
  keys: external_exports.array(valueProofPublicKeySchema).max(32)
}).strict();
var ValueProofVerificationError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "ValueProofVerificationError";
  }
  code;
};
function verifySignedValueProof(proofInput, keySetInput, now = /* @__PURE__ */ new Date()) {
  let proof;
  let keySet;
  try {
    proof = signedValueProofResponseSchema.parse(proofInput);
    keySet = valueProofPublicKeySetSchema.parse(keySetInput);
  } catch {
    throw new ValueProofVerificationError(
      "Value proof or verification key set is malformed.",
      "malformed"
    );
  }
  const issuedAt = Date.parse(proof.payload.issued_at);
  const expiresAt = Date.parse(proof.payload.expires_at);
  if (issuedAt > now.getTime() + VALUE_PROOF_ISSUED_AT_CLOCK_SKEW_MS || expiresAt <= now.getTime()) {
    throw new ValueProofVerificationError(
      "Value proof is expired or not yet valid.",
      "not_current"
    );
  }
  const jwk = keySet.keys.find((candidate) => candidate.kid === proof.key_id);
  if (!jwk) {
    throw new ValueProofVerificationError(
      `Value proof verification key is unavailable: ${proof.key_id}`,
      "key_unavailable"
    );
  }
  if (Buffer.from(jwk.x, "base64url").byteLength !== 32) {
    throw new ValueProofVerificationError(
      "Value proof verification key is invalid.",
      "invalid_key"
    );
  }
  const signature = Buffer.from(proof.signature, "base64url");
  if (signature.byteLength !== 64) {
    throw new ValueProofVerificationError(
      "Value proof signature is malformed.",
      "malformed"
    );
  }
  const verified = verify(
    null,
    Buffer.from(canonicalJson(proof.payload)),
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      format: "jwk"
    }),
    signature
  );
  if (!verified) {
    throw new ValueProofVerificationError(
      "Value proof signature verification failed.",
      "invalid_signature"
    );
  }
  return {
    ...proof,
    signature_verified: true,
    verification_key_id: proof.key_id
  };
}
async function verifySignedValueProofWithKeyRefresh(proofInput, loadKeySet) {
  const keySet = await loadKeySet(false);
  try {
    return verifySignedValueProof(proofInput, keySet);
  } catch (error) {
    if (error.code !== "key_unavailable") {
      throw error;
    }
  }
  return verifySignedValueProof(proofInput, await loadKeySet(true));
}

// ../core/src/verifier.ts
var duplicateCandidateSchema = external_exports.object({
  type: external_exports.enum(["skill", "resource", "remembrance"]),
  id: external_exports.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  slug: external_exports.string().min(1).max(MAX_SHORT_TEXT_LENGTH).optional(),
  similarity: external_exports.number().min(0).max(1)
});
var PROPOSED_METADATA_MAX_KEYWORDS = 25;
var PROPOSED_METADATA_MAX_TAGS = 15;
var PROPOSED_METADATA_MAX_DOMAINS = 8;
var PROPOSED_METADATA_MAX_TERM_LENGTH = 64;
var PROPOSED_METADATA_MAX_RATIONALE_LENGTH = 2e3;
var PROPOSED_METADATA_MAX_MODEL_LENGTH = MAX_SHORT_TEXT_LENGTH;
var LOW_VALUE_PROPOSED_METADATA_EXACT_TERMS = /* @__PURE__ */ new Set([
  "agent",
  "agents",
  "agent-skill",
  "agent-skills",
  "backfill",
  "candidate",
  "candidates",
  "leaderboard",
  "rank",
  "ranking",
  "skill",
  "skills",
  "skills-sh",
  "skill-candidate",
  "skill-candidates"
]);
var LOW_VALUE_PROPOSED_METADATA_PATTERNS = [
  /\bagent\s+skills?\b/i,
  /\bagentspace\b/i,
  /\bskill\s+candidates?\b/i,
  /\bskills?[\s.-]*sh\b/i,
  /\bleaderboard\s+rank\b/i,
  /\bnpx\s+skills\s+add\b/i
];
function sanitizeProposedMetadataTerm(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().slice(0, PROPOSED_METADATA_MAX_TERM_LENGTH);
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.toLowerCase().replace(/[_/.]+/g, "-").replace(/\s+/g, " ").replace(/^-+|-+$/g, "");
  if (LOW_VALUE_PROPOSED_METADATA_EXACT_TERMS.has(normalized)) {
    return null;
  }
  if (LOW_VALUE_PROPOSED_METADATA_PATTERNS.some(
    (pattern) => pattern.test(trimmed)
  )) {
    return null;
  }
  return trimmed;
}
var proposedMetadataTermArraySchema = (max) => external_exports.preprocess(
  (value) => {
    if (!Array.isArray(value)) {
      return value;
    }
    const seen = /* @__PURE__ */ new Set();
    const terms = [];
    for (const entry of value) {
      const trimmed = sanitizeProposedMetadataTerm(entry);
      if (!trimmed) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      terms.push(trimmed);
    }
    return terms.slice(0, max);
  },
  external_exports.array(external_exports.string().min(1).max(PROPOSED_METADATA_MAX_TERM_LENGTH)).max(max)
);
var proposedSkillMetadataSchema = external_exports.object({
  keywords: proposedMetadataTermArraySchema(PROPOSED_METADATA_MAX_KEYWORDS),
  tags: proposedMetadataTermArraySchema(PROPOSED_METADATA_MAX_TAGS),
  domains: proposedMetadataTermArraySchema(PROPOSED_METADATA_MAX_DOMAINS),
  rationale: external_exports.string().trim().min(1).max(PROPOSED_METADATA_MAX_RATIONALE_LENGTH),
  model: external_exports.string().trim().min(1).max(PROPOSED_METADATA_MAX_MODEL_LENGTH)
});
var verifierOutputSchema = external_exports.object({
  recommended_action: verifierActionSchema,
  confidence: external_exports.number().min(0).max(1),
  duplicate_candidates: external_exports.array(duplicateCandidateSchema).max(20).default([]),
  safety_flags: external_exports.array(external_exports.string().min(1).max(MAX_SHORT_TEXT_LENGTH)).max(40).default([]),
  summary: external_exports.string().min(1).max(MAX_LONG_TEXT_LENGTH),
  proposed_patch: external_exports.string().max(MAX_LONG_TEXT_LENGTH).nullable().default(null),
  score_updates: external_exports.record(external_exports.unknown()).superRefine((value, ctx) => {
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).length;
    if (byteLength > MAX_JSON_FIELD_BYTES) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.too_big,
        maximum: MAX_JSON_FIELD_BYTES,
        type: "array",
        inclusive: true,
        message: `score_updates must be ${MAX_JSON_FIELD_BYTES} bytes or smaller`
      });
    }
  }).nullable().default(null),
  // Advisory retrieval enrichment (see proposedSkillMetadataSchema). Optional
  // and defaults to null so existing verifier outputs remain valid.
  proposed_metadata: proposedSkillMetadataSchema.nullable().default(null)
});

// src/server.ts
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as signPayload
} from "node:crypto";

// ../../node_modules/zod-to-json-schema/dist/esm/Options.js
var ignoreOverride = /* @__PURE__ */ Symbol("Let zodToJsonSchema decide on which parser to use");
var defaultOptions = {
  name: void 0,
  $refStrategy: "root",
  basePath: ["#"],
  effectStrategy: "input",
  pipeStrategy: "all",
  dateStrategy: "format:date-time",
  mapStrategy: "entries",
  removeAdditionalStrategy: "passthrough",
  allowedAdditionalProperties: true,
  rejectedAdditionalProperties: false,
  definitionPath: "definitions",
  target: "jsonSchema7",
  strictUnions: false,
  definitions: {},
  errorMessages: false,
  markdownDescription: false,
  patternStrategy: "escape",
  applyRegexFlags: false,
  emailStrategy: "format:email",
  base64Strategy: "contentEncoding:base64",
  nameStrategy: "ref",
  openAiAnyTypeName: "OpenAiAnyType"
};
var getDefaultOptions = (options) => typeof options === "string" ? {
  ...defaultOptions,
  name: options
} : {
  ...defaultOptions,
  ...options
};

// ../../node_modules/zod-to-json-schema/dist/esm/Refs.js
var getRefs = (options) => {
  const _options = getDefaultOptions(options);
  const currentPath = _options.name !== void 0 ? [..._options.basePath, _options.definitionPath, _options.name] : _options.basePath;
  return {
    ..._options,
    flags: { hasReferencedOpenAiAnyType: false },
    currentPath,
    propertyPath: void 0,
    seen: new Map(Object.entries(_options.definitions).map(([name, def]) => [
      def._def,
      {
        def: def._def,
        path: [..._options.basePath, _options.definitionPath, name],
        // Resolution of references will be forced even though seen, so it's ok that the schema is undefined here for now.
        jsonSchema: void 0
      }
    ]))
  };
};

// ../../node_modules/zod-to-json-schema/dist/esm/errorMessages.js
function addErrorMessage(res, key, errorMessage, refs) {
  if (!refs?.errorMessages)
    return;
  if (errorMessage) {
    res.errorMessage = {
      ...res.errorMessage,
      [key]: errorMessage
    };
  }
}
function setResponseValueAndErrors(res, key, value, errorMessage, refs) {
  res[key] = value;
  addErrorMessage(res, key, errorMessage, refs);
}

// ../../node_modules/zod-to-json-schema/dist/esm/getRelativePath.js
var getRelativePath = (pathA, pathB) => {
  let i = 0;
  for (; i < pathA.length && i < pathB.length; i++) {
    if (pathA[i] !== pathB[i])
      break;
  }
  return [(pathA.length - i).toString(), ...pathB.slice(i)].join("/");
};

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/any.js
function parseAnyDef(refs) {
  if (refs.target !== "openAi") {
    return {};
  }
  const anyDefinitionPath = [
    ...refs.basePath,
    refs.definitionPath,
    refs.openAiAnyTypeName
  ];
  refs.flags.hasReferencedOpenAiAnyType = true;
  return {
    $ref: refs.$refStrategy === "relative" ? getRelativePath(anyDefinitionPath, refs.currentPath) : anyDefinitionPath.join("/")
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/array.js
function parseArrayDef(def, refs) {
  const res = {
    type: "array"
  };
  if (def.type?._def && def.type?._def?.typeName !== ZodFirstPartyTypeKind.ZodAny) {
    res.items = parseDef(def.type._def, {
      ...refs,
      currentPath: [...refs.currentPath, "items"]
    });
  }
  if (def.minLength) {
    setResponseValueAndErrors(res, "minItems", def.minLength.value, def.minLength.message, refs);
  }
  if (def.maxLength) {
    setResponseValueAndErrors(res, "maxItems", def.maxLength.value, def.maxLength.message, refs);
  }
  if (def.exactLength) {
    setResponseValueAndErrors(res, "minItems", def.exactLength.value, def.exactLength.message, refs);
    setResponseValueAndErrors(res, "maxItems", def.exactLength.value, def.exactLength.message, refs);
  }
  return res;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/bigint.js
function parseBigintDef(def, refs) {
  const res = {
    type: "integer",
    format: "int64"
  };
  if (!def.checks)
    return res;
  for (const check of def.checks) {
    switch (check.kind) {
      case "min":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMinimum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMinimum = true;
          }
          setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
        }
        break;
      case "max":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMaximum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMaximum = true;
          }
          setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
        }
        break;
      case "multipleOf":
        setResponseValueAndErrors(res, "multipleOf", check.value, check.message, refs);
        break;
    }
  }
  return res;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/boolean.js
function parseBooleanDef() {
  return {
    type: "boolean"
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/branded.js
function parseBrandedDef(_def, refs) {
  return parseDef(_def.type._def, refs);
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/catch.js
var parseCatchDef = (def, refs) => {
  return parseDef(def.innerType._def, refs);
};

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/date.js
function parseDateDef(def, refs, overrideDateStrategy) {
  const strategy = overrideDateStrategy ?? refs.dateStrategy;
  if (Array.isArray(strategy)) {
    return {
      anyOf: strategy.map((item, i) => parseDateDef(def, refs, item))
    };
  }
  switch (strategy) {
    case "string":
    case "format:date-time":
      return {
        type: "string",
        format: "date-time"
      };
    case "format:date":
      return {
        type: "string",
        format: "date"
      };
    case "integer":
      return integerDateParser(def, refs);
  }
}
var integerDateParser = (def, refs) => {
  const res = {
    type: "integer",
    format: "unix-time"
  };
  if (refs.target === "openApi3") {
    return res;
  }
  for (const check of def.checks) {
    switch (check.kind) {
      case "min":
        setResponseValueAndErrors(
          res,
          "minimum",
          check.value,
          // This is in milliseconds
          check.message,
          refs
        );
        break;
      case "max":
        setResponseValueAndErrors(
          res,
          "maximum",
          check.value,
          // This is in milliseconds
          check.message,
          refs
        );
        break;
    }
  }
  return res;
};

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/default.js
function parseDefaultDef(_def, refs) {
  return {
    ...parseDef(_def.innerType._def, refs),
    default: _def.defaultValue()
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/effects.js
function parseEffectsDef(_def, refs) {
  return refs.effectStrategy === "input" ? parseDef(_def.schema._def, refs) : parseAnyDef(refs);
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/enum.js
function parseEnumDef(def) {
  return {
    type: "string",
    enum: Array.from(def.values)
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/intersection.js
var isJsonSchema7AllOfType = (type) => {
  if ("type" in type && type.type === "string")
    return false;
  return "allOf" in type;
};
function parseIntersectionDef(def, refs) {
  const allOf = [
    parseDef(def.left._def, {
      ...refs,
      currentPath: [...refs.currentPath, "allOf", "0"]
    }),
    parseDef(def.right._def, {
      ...refs,
      currentPath: [...refs.currentPath, "allOf", "1"]
    })
  ].filter((x) => !!x);
  let unevaluatedProperties = refs.target === "jsonSchema2019-09" ? { unevaluatedProperties: false } : void 0;
  const mergedAllOf = [];
  allOf.forEach((schema) => {
    if (isJsonSchema7AllOfType(schema)) {
      mergedAllOf.push(...schema.allOf);
      if (schema.unevaluatedProperties === void 0) {
        unevaluatedProperties = void 0;
      }
    } else {
      let nestedSchema = schema;
      if ("additionalProperties" in schema && schema.additionalProperties === false) {
        const { additionalProperties, ...rest } = schema;
        nestedSchema = rest;
      } else {
        unevaluatedProperties = void 0;
      }
      mergedAllOf.push(nestedSchema);
    }
  });
  return mergedAllOf.length ? {
    allOf: mergedAllOf,
    ...unevaluatedProperties
  } : void 0;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/literal.js
function parseLiteralDef(def, refs) {
  const parsedType = typeof def.value;
  if (parsedType !== "bigint" && parsedType !== "number" && parsedType !== "boolean" && parsedType !== "string") {
    return {
      type: Array.isArray(def.value) ? "array" : "object"
    };
  }
  if (refs.target === "openApi3") {
    return {
      type: parsedType === "bigint" ? "integer" : parsedType,
      enum: [def.value]
    };
  }
  return {
    type: parsedType === "bigint" ? "integer" : parsedType,
    const: def.value
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/string.js
var emojiRegex2 = void 0;
var zodPatterns = {
  /**
   * `c` was changed to `[cC]` to replicate /i flag
   */
  cuid: /^[cC][^\s-]{8,}$/,
  cuid2: /^[0-9a-z]+$/,
  ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  /**
   * `a-z` was added to replicate /i flag
   */
  email: /^(?!\.)(?!.*\.\.)([a-zA-Z0-9_'+\-\.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}$/,
  /**
   * Constructed a valid Unicode RegExp
   *
   * Lazily instantiate since this type of regex isn't supported
   * in all envs (e.g. React Native).
   *
   * See:
   * https://github.com/colinhacks/zod/issues/2433
   * Fix in Zod:
   * https://github.com/colinhacks/zod/commit/9340fd51e48576a75adc919bff65dbc4a5d4c99b
   */
  emoji: () => {
    if (emojiRegex2 === void 0) {
      emojiRegex2 = RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
    }
    return emojiRegex2;
  },
  /**
   * Unused
   */
  uuid: /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
  /**
   * Unused
   */
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
  ipv4Cidr: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/,
  /**
   * Unused
   */
  ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,
  ipv6Cidr: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
  base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
  base64url: /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/,
  nanoid: /^[a-zA-Z0-9_-]{21}$/,
  jwt: /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/
};
function parseStringDef(def, refs) {
  const res = {
    type: "string"
  };
  if (def.checks) {
    for (const check of def.checks) {
      switch (check.kind) {
        case "min":
          setResponseValueAndErrors(res, "minLength", typeof res.minLength === "number" ? Math.max(res.minLength, check.value) : check.value, check.message, refs);
          break;
        case "max":
          setResponseValueAndErrors(res, "maxLength", typeof res.maxLength === "number" ? Math.min(res.maxLength, check.value) : check.value, check.message, refs);
          break;
        case "email":
          switch (refs.emailStrategy) {
            case "format:email":
              addFormat(res, "email", check.message, refs);
              break;
            case "format:idn-email":
              addFormat(res, "idn-email", check.message, refs);
              break;
            case "pattern:zod":
              addPattern(res, zodPatterns.email, check.message, refs);
              break;
          }
          break;
        case "url":
          addFormat(res, "uri", check.message, refs);
          break;
        case "uuid":
          addFormat(res, "uuid", check.message, refs);
          break;
        case "regex":
          addPattern(res, check.regex, check.message, refs);
          break;
        case "cuid":
          addPattern(res, zodPatterns.cuid, check.message, refs);
          break;
        case "cuid2":
          addPattern(res, zodPatterns.cuid2, check.message, refs);
          break;
        case "startsWith":
          addPattern(res, RegExp(`^${escapeLiteralCheckValue(check.value, refs)}`), check.message, refs);
          break;
        case "endsWith":
          addPattern(res, RegExp(`${escapeLiteralCheckValue(check.value, refs)}$`), check.message, refs);
          break;
        case "datetime":
          addFormat(res, "date-time", check.message, refs);
          break;
        case "date":
          addFormat(res, "date", check.message, refs);
          break;
        case "time":
          addFormat(res, "time", check.message, refs);
          break;
        case "duration":
          addFormat(res, "duration", check.message, refs);
          break;
        case "length":
          setResponseValueAndErrors(res, "minLength", typeof res.minLength === "number" ? Math.max(res.minLength, check.value) : check.value, check.message, refs);
          setResponseValueAndErrors(res, "maxLength", typeof res.maxLength === "number" ? Math.min(res.maxLength, check.value) : check.value, check.message, refs);
          break;
        case "includes": {
          addPattern(res, RegExp(escapeLiteralCheckValue(check.value, refs)), check.message, refs);
          break;
        }
        case "ip": {
          if (check.version !== "v6") {
            addFormat(res, "ipv4", check.message, refs);
          }
          if (check.version !== "v4") {
            addFormat(res, "ipv6", check.message, refs);
          }
          break;
        }
        case "base64url":
          addPattern(res, zodPatterns.base64url, check.message, refs);
          break;
        case "jwt":
          addPattern(res, zodPatterns.jwt, check.message, refs);
          break;
        case "cidr": {
          if (check.version !== "v6") {
            addPattern(res, zodPatterns.ipv4Cidr, check.message, refs);
          }
          if (check.version !== "v4") {
            addPattern(res, zodPatterns.ipv6Cidr, check.message, refs);
          }
          break;
        }
        case "emoji":
          addPattern(res, zodPatterns.emoji(), check.message, refs);
          break;
        case "ulid": {
          addPattern(res, zodPatterns.ulid, check.message, refs);
          break;
        }
        case "base64": {
          switch (refs.base64Strategy) {
            case "format:binary": {
              addFormat(res, "binary", check.message, refs);
              break;
            }
            case "contentEncoding:base64": {
              setResponseValueAndErrors(res, "contentEncoding", "base64", check.message, refs);
              break;
            }
            case "pattern:zod": {
              addPattern(res, zodPatterns.base64, check.message, refs);
              break;
            }
          }
          break;
        }
        case "nanoid": {
          addPattern(res, zodPatterns.nanoid, check.message, refs);
        }
        case "toLowerCase":
        case "toUpperCase":
        case "trim":
          break;
        default:
          /* @__PURE__ */ ((_) => {
          })(check);
      }
    }
  }
  return res;
}
function escapeLiteralCheckValue(literal, refs) {
  return refs.patternStrategy === "escape" ? escapeNonAlphaNumeric(literal) : literal;
}
var ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
function escapeNonAlphaNumeric(source) {
  let result = "";
  for (let i = 0; i < source.length; i++) {
    if (!ALPHA_NUMERIC.has(source[i])) {
      result += "\\";
    }
    result += source[i];
  }
  return result;
}
function addFormat(schema, value, message, refs) {
  if (schema.format || schema.anyOf?.some((x) => x.format)) {
    if (!schema.anyOf) {
      schema.anyOf = [];
    }
    if (schema.format) {
      schema.anyOf.push({
        format: schema.format,
        ...schema.errorMessage && refs.errorMessages && {
          errorMessage: { format: schema.errorMessage.format }
        }
      });
      delete schema.format;
      if (schema.errorMessage) {
        delete schema.errorMessage.format;
        if (Object.keys(schema.errorMessage).length === 0) {
          delete schema.errorMessage;
        }
      }
    }
    schema.anyOf.push({
      format: value,
      ...message && refs.errorMessages && { errorMessage: { format: message } }
    });
  } else {
    setResponseValueAndErrors(schema, "format", value, message, refs);
  }
}
function addPattern(schema, regex, message, refs) {
  if (schema.pattern || schema.allOf?.some((x) => x.pattern)) {
    if (!schema.allOf) {
      schema.allOf = [];
    }
    if (schema.pattern) {
      schema.allOf.push({
        pattern: schema.pattern,
        ...schema.errorMessage && refs.errorMessages && {
          errorMessage: { pattern: schema.errorMessage.pattern }
        }
      });
      delete schema.pattern;
      if (schema.errorMessage) {
        delete schema.errorMessage.pattern;
        if (Object.keys(schema.errorMessage).length === 0) {
          delete schema.errorMessage;
        }
      }
    }
    schema.allOf.push({
      pattern: stringifyRegExpWithFlags(regex, refs),
      ...message && refs.errorMessages && { errorMessage: { pattern: message } }
    });
  } else {
    setResponseValueAndErrors(schema, "pattern", stringifyRegExpWithFlags(regex, refs), message, refs);
  }
}
function stringifyRegExpWithFlags(regex, refs) {
  if (!refs.applyRegexFlags || !regex.flags) {
    return regex.source;
  }
  const flags = {
    i: regex.flags.includes("i"),
    m: regex.flags.includes("m"),
    s: regex.flags.includes("s")
    // `.` matches newlines
  };
  const source = flags.i ? regex.source.toLowerCase() : regex.source;
  let pattern = "";
  let isEscaped = false;
  let inCharGroup = false;
  let inCharRange = false;
  for (let i = 0; i < source.length; i++) {
    if (isEscaped) {
      pattern += source[i];
      isEscaped = false;
      continue;
    }
    if (flags.i) {
      if (inCharGroup) {
        if (source[i].match(/[a-z]/)) {
          if (inCharRange) {
            pattern += source[i];
            pattern += `${source[i - 2]}-${source[i]}`.toUpperCase();
            inCharRange = false;
          } else if (source[i + 1] === "-" && source[i + 2]?.match(/[a-z]/)) {
            pattern += source[i];
            inCharRange = true;
          } else {
            pattern += `${source[i]}${source[i].toUpperCase()}`;
          }
          continue;
        }
      } else if (source[i].match(/[a-z]/)) {
        pattern += `[${source[i]}${source[i].toUpperCase()}]`;
        continue;
      }
    }
    if (flags.m) {
      if (source[i] === "^") {
        pattern += `(^|(?<=[\r
]))`;
        continue;
      } else if (source[i] === "$") {
        pattern += `($|(?=[\r
]))`;
        continue;
      }
    }
    if (flags.s && source[i] === ".") {
      pattern += inCharGroup ? `${source[i]}\r
` : `[${source[i]}\r
]`;
      continue;
    }
    pattern += source[i];
    if (source[i] === "\\") {
      isEscaped = true;
    } else if (inCharGroup && source[i] === "]") {
      inCharGroup = false;
    } else if (!inCharGroup && source[i] === "[") {
      inCharGroup = true;
    }
  }
  try {
    new RegExp(pattern);
  } catch {
    console.warn(`Could not convert regex pattern at ${refs.currentPath.join("/")} to a flag-independent form! Falling back to the flag-ignorant source`);
    return regex.source;
  }
  return pattern;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/record.js
function parseRecordDef(def, refs) {
  if (refs.target === "openAi") {
    console.warn("Warning: OpenAI may not support records in schemas! Try an array of key-value pairs instead.");
  }
  if (refs.target === "openApi3" && def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    return {
      type: "object",
      required: def.keyType._def.values,
      properties: def.keyType._def.values.reduce((acc, key) => ({
        ...acc,
        [key]: parseDef(def.valueType._def, {
          ...refs,
          currentPath: [...refs.currentPath, "properties", key]
        }) ?? parseAnyDef(refs)
      }), {}),
      additionalProperties: refs.rejectedAdditionalProperties
    };
  }
  const schema = {
    type: "object",
    additionalProperties: parseDef(def.valueType._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    }) ?? refs.allowedAdditionalProperties
  };
  if (refs.target === "openApi3") {
    return schema;
  }
  if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodString && def.keyType._def.checks?.length) {
    const { type, ...keyType } = parseStringDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  } else if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    return {
      ...schema,
      propertyNames: {
        enum: def.keyType._def.values
      }
    };
  } else if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodBranded && def.keyType._def.type._def.typeName === ZodFirstPartyTypeKind.ZodString && def.keyType._def.type._def.checks?.length) {
    const { type, ...keyType } = parseBrandedDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  }
  return schema;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/map.js
function parseMapDef(def, refs) {
  if (refs.mapStrategy === "record") {
    return parseRecordDef(def, refs);
  }
  const keys = parseDef(def.keyType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items", "items", "0"]
  }) || parseAnyDef(refs);
  const values = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items", "items", "1"]
  }) || parseAnyDef(refs);
  return {
    type: "array",
    maxItems: 125,
    items: {
      type: "array",
      items: [keys, values],
      minItems: 2,
      maxItems: 2
    }
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/nativeEnum.js
function parseNativeEnumDef(def) {
  const object = def.values;
  const actualKeys = Object.keys(def.values).filter((key) => {
    return typeof object[object[key]] !== "number";
  });
  const actualValues = actualKeys.map((key) => object[key]);
  const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
  return {
    type: parsedTypes.length === 1 ? parsedTypes[0] === "string" ? "string" : "number" : ["string", "number"],
    enum: actualValues
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/never.js
function parseNeverDef(refs) {
  return refs.target === "openAi" ? void 0 : {
    not: parseAnyDef({
      ...refs,
      currentPath: [...refs.currentPath, "not"]
    })
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/null.js
function parseNullDef(refs) {
  return refs.target === "openApi3" ? {
    enum: ["null"],
    nullable: true
  } : {
    type: "null"
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/union.js
var primitiveMappings = {
  ZodString: "string",
  ZodNumber: "number",
  ZodBigInt: "integer",
  ZodBoolean: "boolean",
  ZodNull: "null"
};
function parseUnionDef(def, refs) {
  if (refs.target === "openApi3")
    return asAnyOf(def, refs);
  const options = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
  if (options.every((x) => x._def.typeName in primitiveMappings && (!x._def.checks || !x._def.checks.length))) {
    const types = options.reduce((types2, x) => {
      const type = primitiveMappings[x._def.typeName];
      return type && !types2.includes(type) ? [...types2, type] : types2;
    }, []);
    return {
      type: types.length > 1 ? types : types[0]
    };
  } else if (options.every((x) => x._def.typeName === "ZodLiteral" && !x.description)) {
    const types = options.reduce((acc, x) => {
      const type = typeof x._def.value;
      switch (type) {
        case "string":
        case "number":
        case "boolean":
          return [...acc, type];
        case "bigint":
          return [...acc, "integer"];
        case "object":
          if (x._def.value === null)
            return [...acc, "null"];
        case "symbol":
        case "undefined":
        case "function":
        default:
          return acc;
      }
    }, []);
    if (types.length === options.length) {
      const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
      return {
        type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0],
        enum: options.reduce((acc, x) => {
          return acc.includes(x._def.value) ? acc : [...acc, x._def.value];
        }, [])
      };
    }
  } else if (options.every((x) => x._def.typeName === "ZodEnum")) {
    return {
      type: "string",
      enum: options.reduce((acc, x) => [
        ...acc,
        ...x._def.values.filter((x2) => !acc.includes(x2))
      ], [])
    };
  }
  return asAnyOf(def, refs);
}
var asAnyOf = (def, refs) => {
  const anyOf = (def.options instanceof Map ? Array.from(def.options.values()) : def.options).map((x, i) => parseDef(x._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", `${i}`]
  })).filter((x) => !!x && (!refs.strictUnions || typeof x === "object" && Object.keys(x).length > 0));
  return anyOf.length ? { anyOf } : void 0;
};

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/nullable.js
function parseNullableDef(def, refs) {
  if (["ZodString", "ZodNumber", "ZodBigInt", "ZodBoolean", "ZodNull"].includes(def.innerType._def.typeName) && (!def.innerType._def.checks || !def.innerType._def.checks.length)) {
    if (refs.target === "openApi3") {
      return {
        type: primitiveMappings[def.innerType._def.typeName],
        nullable: true
      };
    }
    return {
      type: [
        primitiveMappings[def.innerType._def.typeName],
        "null"
      ]
    };
  }
  if (refs.target === "openApi3") {
    const base2 = parseDef(def.innerType._def, {
      ...refs,
      currentPath: [...refs.currentPath]
    });
    if (base2 && "$ref" in base2)
      return { allOf: [base2], nullable: true };
    return base2 && { ...base2, nullable: true };
  }
  const base = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", "0"]
  });
  return base && { anyOf: [base, { type: "null" }] };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/number.js
function parseNumberDef(def, refs) {
  const res = {
    type: "number"
  };
  if (!def.checks)
    return res;
  for (const check of def.checks) {
    switch (check.kind) {
      case "int":
        res.type = "integer";
        addErrorMessage(res, "type", check.message, refs);
        break;
      case "min":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMinimum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMinimum = true;
          }
          setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
        }
        break;
      case "max":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMaximum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMaximum = true;
          }
          setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
        }
        break;
      case "multipleOf":
        setResponseValueAndErrors(res, "multipleOf", check.value, check.message, refs);
        break;
    }
  }
  return res;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/object.js
function parseObjectDef(def, refs) {
  const forceOptionalIntoNullable = refs.target === "openAi";
  const result = {
    type: "object",
    properties: {}
  };
  const required = [];
  const shape = def.shape();
  for (const propName in shape) {
    let propDef = shape[propName];
    if (propDef === void 0 || propDef._def === void 0) {
      continue;
    }
    let propOptional = safeIsOptional(propDef);
    if (propOptional && forceOptionalIntoNullable) {
      if (propDef._def.typeName === "ZodOptional") {
        propDef = propDef._def.innerType;
      }
      if (!propDef.isNullable()) {
        propDef = propDef.nullable();
      }
      propOptional = false;
    }
    const parsedDef = parseDef(propDef._def, {
      ...refs,
      currentPath: [...refs.currentPath, "properties", propName],
      propertyPath: [...refs.currentPath, "properties", propName]
    });
    if (parsedDef === void 0) {
      continue;
    }
    result.properties[propName] = parsedDef;
    if (!propOptional) {
      required.push(propName);
    }
  }
  if (required.length) {
    result.required = required;
  }
  const additionalProperties = decideAdditionalProperties(def, refs);
  if (additionalProperties !== void 0) {
    result.additionalProperties = additionalProperties;
  }
  return result;
}
function decideAdditionalProperties(def, refs) {
  if (def.catchall._def.typeName !== "ZodNever") {
    return parseDef(def.catchall._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    });
  }
  switch (def.unknownKeys) {
    case "passthrough":
      return refs.allowedAdditionalProperties;
    case "strict":
      return refs.rejectedAdditionalProperties;
    case "strip":
      return refs.removeAdditionalStrategy === "strict" ? refs.allowedAdditionalProperties : refs.rejectedAdditionalProperties;
  }
}
function safeIsOptional(schema) {
  try {
    return schema.isOptional();
  } catch {
    return true;
  }
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/optional.js
var parseOptionalDef = (def, refs) => {
  if (refs.currentPath.toString() === refs.propertyPath?.toString()) {
    return parseDef(def.innerType._def, refs);
  }
  const innerSchema = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", "1"]
  });
  return innerSchema ? {
    anyOf: [
      {
        not: parseAnyDef(refs)
      },
      innerSchema
    ]
  } : parseAnyDef(refs);
};

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/pipeline.js
var parsePipelineDef = (def, refs) => {
  if (refs.pipeStrategy === "input") {
    return parseDef(def.in._def, refs);
  } else if (refs.pipeStrategy === "output") {
    return parseDef(def.out._def, refs);
  }
  const a = parseDef(def.in._def, {
    ...refs,
    currentPath: [...refs.currentPath, "allOf", "0"]
  });
  const b = parseDef(def.out._def, {
    ...refs,
    currentPath: [...refs.currentPath, "allOf", a ? "1" : "0"]
  });
  return {
    allOf: [a, b].filter((x) => x !== void 0)
  };
};

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/promise.js
function parsePromiseDef(def, refs) {
  return parseDef(def.type._def, refs);
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/set.js
function parseSetDef(def, refs) {
  const items = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items"]
  });
  const schema = {
    type: "array",
    uniqueItems: true,
    items
  };
  if (def.minSize) {
    setResponseValueAndErrors(schema, "minItems", def.minSize.value, def.minSize.message, refs);
  }
  if (def.maxSize) {
    setResponseValueAndErrors(schema, "maxItems", def.maxSize.value, def.maxSize.message, refs);
  }
  return schema;
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/tuple.js
function parseTupleDef(def, refs) {
  if (def.rest) {
    return {
      type: "array",
      minItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", `${i}`]
      })).reduce((acc, x) => x === void 0 ? acc : [...acc, x], []),
      additionalItems: parseDef(def.rest._def, {
        ...refs,
        currentPath: [...refs.currentPath, "additionalItems"]
      })
    };
  } else {
    return {
      type: "array",
      minItems: def.items.length,
      maxItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", `${i}`]
      })).reduce((acc, x) => x === void 0 ? acc : [...acc, x], [])
    };
  }
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/undefined.js
function parseUndefinedDef(refs) {
  return {
    not: parseAnyDef(refs)
  };
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/unknown.js
function parseUnknownDef(refs) {
  return parseAnyDef(refs);
}

// ../../node_modules/zod-to-json-schema/dist/esm/parsers/readonly.js
var parseReadonlyDef = (def, refs) => {
  return parseDef(def.innerType._def, refs);
};

// ../../node_modules/zod-to-json-schema/dist/esm/selectParser.js
var selectParser = (def, typeName, refs) => {
  switch (typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      return parseStringDef(def, refs);
    case ZodFirstPartyTypeKind.ZodNumber:
      return parseNumberDef(def, refs);
    case ZodFirstPartyTypeKind.ZodObject:
      return parseObjectDef(def, refs);
    case ZodFirstPartyTypeKind.ZodBigInt:
      return parseBigintDef(def, refs);
    case ZodFirstPartyTypeKind.ZodBoolean:
      return parseBooleanDef();
    case ZodFirstPartyTypeKind.ZodDate:
      return parseDateDef(def, refs);
    case ZodFirstPartyTypeKind.ZodUndefined:
      return parseUndefinedDef(refs);
    case ZodFirstPartyTypeKind.ZodNull:
      return parseNullDef(refs);
    case ZodFirstPartyTypeKind.ZodArray:
      return parseArrayDef(def, refs);
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return parseUnionDef(def, refs);
    case ZodFirstPartyTypeKind.ZodIntersection:
      return parseIntersectionDef(def, refs);
    case ZodFirstPartyTypeKind.ZodTuple:
      return parseTupleDef(def, refs);
    case ZodFirstPartyTypeKind.ZodRecord:
      return parseRecordDef(def, refs);
    case ZodFirstPartyTypeKind.ZodLiteral:
      return parseLiteralDef(def, refs);
    case ZodFirstPartyTypeKind.ZodEnum:
      return parseEnumDef(def);
    case ZodFirstPartyTypeKind.ZodNativeEnum:
      return parseNativeEnumDef(def);
    case ZodFirstPartyTypeKind.ZodNullable:
      return parseNullableDef(def, refs);
    case ZodFirstPartyTypeKind.ZodOptional:
      return parseOptionalDef(def, refs);
    case ZodFirstPartyTypeKind.ZodMap:
      return parseMapDef(def, refs);
    case ZodFirstPartyTypeKind.ZodSet:
      return parseSetDef(def, refs);
    case ZodFirstPartyTypeKind.ZodLazy:
      return () => def.getter()._def;
    case ZodFirstPartyTypeKind.ZodPromise:
      return parsePromiseDef(def, refs);
    case ZodFirstPartyTypeKind.ZodNaN:
    case ZodFirstPartyTypeKind.ZodNever:
      return parseNeverDef(refs);
    case ZodFirstPartyTypeKind.ZodEffects:
      return parseEffectsDef(def, refs);
    case ZodFirstPartyTypeKind.ZodAny:
      return parseAnyDef(refs);
    case ZodFirstPartyTypeKind.ZodUnknown:
      return parseUnknownDef(refs);
    case ZodFirstPartyTypeKind.ZodDefault:
      return parseDefaultDef(def, refs);
    case ZodFirstPartyTypeKind.ZodBranded:
      return parseBrandedDef(def, refs);
    case ZodFirstPartyTypeKind.ZodReadonly:
      return parseReadonlyDef(def, refs);
    case ZodFirstPartyTypeKind.ZodCatch:
      return parseCatchDef(def, refs);
    case ZodFirstPartyTypeKind.ZodPipeline:
      return parsePipelineDef(def, refs);
    case ZodFirstPartyTypeKind.ZodFunction:
    case ZodFirstPartyTypeKind.ZodVoid:
    case ZodFirstPartyTypeKind.ZodSymbol:
      return void 0;
    default:
      return /* @__PURE__ */ ((_) => void 0)(typeName);
  }
};

// ../../node_modules/zod-to-json-schema/dist/esm/parseDef.js
function parseDef(def, refs, forceResolution = false) {
  const seenItem = refs.seen.get(def);
  if (refs.override) {
    const overrideResult = refs.override?.(def, refs, seenItem, forceResolution);
    if (overrideResult !== ignoreOverride) {
      return overrideResult;
    }
  }
  if (seenItem && !forceResolution) {
    const seenSchema = get$ref(seenItem, refs);
    if (seenSchema !== void 0) {
      return seenSchema;
    }
  }
  const newItem = { def, path: refs.currentPath, jsonSchema: void 0 };
  refs.seen.set(def, newItem);
  const jsonSchemaOrGetter = selectParser(def, def.typeName, refs);
  const jsonSchema = typeof jsonSchemaOrGetter === "function" ? parseDef(jsonSchemaOrGetter(), refs) : jsonSchemaOrGetter;
  if (jsonSchema) {
    addMeta(def, refs, jsonSchema);
  }
  if (refs.postProcess) {
    const postProcessResult = refs.postProcess(jsonSchema, def, refs);
    newItem.jsonSchema = jsonSchema;
    return postProcessResult;
  }
  newItem.jsonSchema = jsonSchema;
  return jsonSchema;
}
var get$ref = (item, refs) => {
  switch (refs.$refStrategy) {
    case "root":
      return { $ref: item.path.join("/") };
    case "relative":
      return { $ref: getRelativePath(refs.currentPath, item.path) };
    case "none":
    case "seen": {
      if (item.path.length < refs.currentPath.length && item.path.every((value, index) => refs.currentPath[index] === value)) {
        console.warn(`Recursive reference detected at ${refs.currentPath.join("/")}! Defaulting to any`);
        return parseAnyDef(refs);
      }
      return refs.$refStrategy === "seen" ? parseAnyDef(refs) : void 0;
    }
  }
};
var addMeta = (def, refs, jsonSchema) => {
  if (def.description) {
    jsonSchema.description = def.description;
    if (refs.markdownDescription) {
      jsonSchema.markdownDescription = def.description;
    }
  }
  return jsonSchema;
};

// ../../node_modules/zod-to-json-schema/dist/esm/zodToJsonSchema.js
var zodToJsonSchema = (schema, options) => {
  const refs = getRefs(options);
  let definitions = typeof options === "object" && options.definitions ? Object.entries(options.definitions).reduce((acc, [name2, schema2]) => ({
    ...acc,
    [name2]: parseDef(schema2._def, {
      ...refs,
      currentPath: [...refs.basePath, refs.definitionPath, name2]
    }, true) ?? parseAnyDef(refs)
  }), {}) : void 0;
  const name = typeof options === "string" ? options : options?.nameStrategy === "title" ? void 0 : options?.name;
  const main = parseDef(schema._def, name === void 0 ? refs : {
    ...refs,
    currentPath: [...refs.basePath, refs.definitionPath, name]
  }, false) ?? parseAnyDef(refs);
  const title = typeof options === "object" && options.name !== void 0 && options.nameStrategy === "title" ? options.name : void 0;
  if (title !== void 0) {
    main.title = title;
  }
  if (refs.flags.hasReferencedOpenAiAnyType) {
    if (!definitions) {
      definitions = {};
    }
    if (!definitions[refs.openAiAnyTypeName]) {
      definitions[refs.openAiAnyTypeName] = {
        // Skipping "object" as no properties can be defined and additionalProperties must be "false"
        type: ["string", "number", "integer", "boolean", "array", "null"],
        items: {
          $ref: refs.$refStrategy === "relative" ? "1" : [
            ...refs.basePath,
            refs.definitionPath,
            refs.openAiAnyTypeName
          ].join("/")
        }
      };
    }
  }
  const combined = name === void 0 ? definitions ? {
    ...main,
    [refs.definitionPath]: definitions
  } : main : {
    $ref: [
      ...refs.$refStrategy === "relative" ? [] : refs.basePath,
      refs.definitionPath,
      name
    ].join("/"),
    [refs.definitionPath]: {
      ...definitions,
      [name]: main
    }
  };
  if (refs.target === "jsonSchema7") {
    combined.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (refs.target === "jsonSchema2019-09" || refs.target === "openAi") {
    combined.$schema = "https://json-schema.org/draft/2019-09/schema#";
  }
  if (refs.target === "openAi" && ("anyOf" in combined || "oneOf" in combined || "allOf" in combined || "type" in combined && Array.isArray(combined.type))) {
    console.warn("Warning: OpenAI may not support schemas with unions as roots! Try wrapping it in an object property.");
  }
  return combined;
};

// src/tool-definitions.ts
var getBySlugSchema = external_exports.object({
  slug: external_exports.string().min(1).describe("Public skill or resource slug."),
  query_id: external_exports.string().min(1).optional().describe("Originating query_id, when this result came from query_skills."),
  result_id: external_exports.string().min(1).optional().describe("Originating result_id, when available.")
});
var getValueProofSchema = external_exports.object({
  id: external_exports.string().min(1).describe("Value proof id returned with potential_savings.")
});
var bootstrapAgentIdentitySchema = external_exports.object({
  subject: external_exports.string().min(1).describe("Stable agent identity, for example codex:user@example.com."),
  provider: external_exports.enum(["other", "codex", "cursor", "claude_code"]).default("other").describe(
    "Use other for independent TOFU keys. Use codex/cursor/claude_code only for Remembrance-registered plugin keys."
  ),
  key_id: external_exports.string().min(1).optional(),
  key_path: external_exports.string().min(1).optional().describe("Override key file path. Defaults to XDG config."),
  force_rotate: external_exports.boolean().default(false).describe("Generate and register a new key even when one exists.")
});
var feedbackToolSchema = agentFeedbackRequestBaseSchema.extend({
  verified_attestation: external_exports.boolean().default(false).describe(
    "When true, sign the feedback with the local TOFU key if present."
  )
}).superRefine((value, ctx) => {
  if (Boolean(value.query_id) !== Boolean(value.result_id)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "query_id and result_id must be supplied together",
      path: value.query_id ? ["result_id"] : ["query_id"]
    });
  }
});
var remembranceToolSchema = remembrancePayloadSchema.extend({
  verified_attestation: external_exports.boolean().default(false).describe(
    "When true, sign the remembrance with the local TOFU key if present. Requires skill.slug."
  )
});
var toolDefinitions = [
  tool(
    "query_skills",
    REMEMBRANCE_QUERY_TOOL_DESCRIPTION,
    "/api/v1/agent/query",
    agentQueryRequestSchema
  ),
  tool(
    "list_skills",
    "Browse the live authorized skill catalog without loading full instructions. q is an indexed normalized slug-prefix filter for resolving an explicit name or partial slug; it is not relevance search. Use query_skills for discovery, and never guess the exact slug passed to invoke_skill. Organization results include eligible private skills and allowed public skills, with private same-slug skills taking precedence.",
    "/api/v1/agent/skill-catalog",
    skillCatalogRequestSchema,
    "GET"
  ),
  tool(
    "invoke_skill",
    "Load an explicitly selected skill through the authoritative policy boundary. Use an exact slug returned by list_skills, an MCP resource, or query_skills. This resolves the current active reviewed version, records direct selection, and returns post-use feedback and outcome instructions. Do not use submit_query_feedback for this explicit selection.",
    "/api/v1/agent/skill-invocations",
    agentSkillInvocationRequestSchema
  ),
  tool(
    "get_skill",
    "Fetch a known skill by slug after query_skills returns it. Pass query_id and result_id from that response so Remembrance can measure whether surfaced guidance was opened. Do not guess private or inactive slugs.",
    "/api/v1/skills/{slug}",
    getBySlugSchema,
    "GET"
  ),
  tool(
    "get_resource",
    "Fetch a known resource by slug after query_skills returns it. Pass query_id and result_id from that response so Remembrance can measure whether surfaced guidance was opened. Do not use for arbitrary URL fetching.",
    "/api/v1/resources/{slug}",
    getBySlugSchema,
    "GET"
  ),
  localTool(
    "bootstrap_agent_identity",
    "Create or reuse a local Ed25519 TOFU key and register it with Remembrance. Use once per agent installation; rerun to re-bootstrap if the local agent-key.json was lost.",
    "bootstrap_agent_identity",
    bootstrapAgentIdentitySchema
  ),
  tool(
    "submit_feedback",
    "Submit minimal post-use skill feedback. When the skill came from query_skills, pass its query_id and result_id to close the surfaced-to-use funnel. If the response includes next_step.submit_remembrance_payload, call submit_remembrance to promote substantive feedback to rich evidence. For self-corrections or CI/deploy/release misses, use submit_remembrance with type failure_report.",
    "/api/v1/agent/feedback",
    feedbackToolSchema
  ),
  tool(
    "submit_query_feedback",
    "Submit one complete set of explicit good, partial, or poor judgments for result_id values from one query_skills call, using the same auth scope as that query. Unrated results stay neutral. An identical retry is safe, but changed later judgments conflict. Same-query better/worse labels can train retrieval without changing global skill usefulness; use submit_feedback only after actually using a skill.",
    "/api/v1/agent/query-feedback",
    agentQueryFeedbackRequestSchema
  ),
  tool(
    "report_task_outcome",
    "Report completion or abandonment for a query. Remembrance accepts one terminal outcome per query; retry the same report with the same idempotency_key, and do not submit a different later outcome. Include only result_ids listed in task_outcome.eligible_result_ids; each result and bundle also carries task_outcome_eligible. When two or three selected skills exactly match a returned skill_bundles entry, include its bundle_id for value attribution; other combinations are accepted as funnel telemetry but do not train a skill or bundle cohort. Include bounded token totals only when the runtime exposes them. For Vercel AI Gateway work, include metering_reference.adapter=vercel_ai_gateway and every gen_ generation ID used by the task (maximum eight); Remembrance retrieves authoritative usage asynchronously, and caller totals never establish proof trust. Never send prompts, outputs, source paths, private URLs, transcripts, or proprietary task content. Completion without token counts still closes the funnel but cannot establish metered savings proof.",
    "/api/v1/agent/task-outcomes",
    agentTaskOutcomeRequestSchema
  ),
  tool(
    "get_value_proof",
    "Fetch and cryptographically verify the token-only signed proof referenced by a qualified potential_savings estimate. Successful results include signature_verified=true. Public-skill proofs are anonymous reads; organization-skill proofs require an active query-capable API key from the same organization, but not necessarily the key used for the original query. Proof payloads contain no organization identity, task identity, price, credit, subscription, or payment data.",
    "/api/v1/value-proofs/{id}",
    getValueProofSchema,
    "GET"
  ),
  tool(
    "submit_remembrance",
    "Submit a full remembrance payload with detailed reusable evidence, including high-value self-corrections, user-caught mistakes, CI/deploy failures, and release/versioning misses as type failure_report. Do not include secrets or raw private payloads.",
    "/api/v1/agent/remembrances",
    remembranceToolSchema
  ),
  tool(
    "propose_skill_idea",
    "Propose a missing reusable skill when query_skills has no useful result.",
    "/api/v1/agent/skill-ideas",
    skillIdeaRequestSchema
  ),
  tool(
    "submit_suggestion",
    "Suggest a safe update to an existing skill. Do not submit prompt-injection text, secrets, or install URL changes.",
    "/api/v1/agent/suggestions",
    suggestionRequestSchema
  ),
  tool(
    "submit_resource",
    "Submit a discovered reusable API, MPP endpoint, MCP server, docs site, package, dataset, service, or tool.",
    "/api/v1/resources",
    resourceSubmissionRequestSchema
  ),
  tool(
    "submit_resource_review",
    "Submit a review after using a resource. Include ratings and redacted evidence only.",
    "/api/v1/resources/reviews",
    resourceReviewRequestSchema
  ),
  tool(
    "request_attestation_challenge",
    "Request a challenge for manually signing remembrance or resource-review evidence.",
    "/api/v1/agent/attest/challenge",
    attestationChallengeRequestSchema
  ),
  tool(
    "register_agent_key",
    "Register a TOFU public key with a proof signature. Prefer bootstrap_agent_identity unless you manage keys yourself.",
    "/api/v1/agent/keys/register",
    attestationKeyRegistrationRequestSchema
  )
];
function tool(name, description, endpoint, schema, method = "POST") {
  return {
    name,
    description,
    endpoint,
    method,
    schema,
    inputSchema: inputSchemaFor(schema, name)
  };
}
function localTool(name, description, local, schema) {
  return {
    name,
    description,
    local,
    schema,
    inputSchema: inputSchemaFor(schema, name)
  };
}
function inputSchemaFor(schema, name) {
  const converted = zodToJsonSchema(schema, {
    name,
    $refStrategy: "none"
  });
  const definitions = converted.definitions;
  return definitions?.[name] ?? converted;
}

// src/server.ts
function remembranceConfigPath() {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "remembrance",
    "config.json"
  );
}
function readRemembranceConfig() {
  try {
    const parsed = JSON.parse(
      readFileSync(remembranceConfigPath(), "utf8")
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function resolveApiKey() {
  const fromEnv = process.env.REMEMBRANCE_API_KEY;
  if (fromEnv) {
    return fromEnv;
  }
  const fromFile = readRemembranceConfig().apiKey;
  return fromFile ? String(fromFile) : "";
}
var apiBase = (process.env.REMEMBRANCE_API_URL || readRemembranceConfig().apiUrl || "https://remembrance.dev").replace(/\/$/, "");
var SERVER_VERSION = true ? "0.1.33" : "0.0.0-dev";
var tools = toolDefinitions;
var inputBuffer = Buffer.alloc(0);
var clientFraming = "ndjson";
var cachedEconomicsSession = null;
var cachedValueProofKeys = null;
process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processMessages().catch((error) => {
    writeResponse(null, null, {
      code: -32603,
      message: error instanceof Error ? error.message : "Internal error"
    });
  });
});
async function processMessages() {
  const parsed = readJsonRpcMessages(inputBuffer);
  inputBuffer = parsed.remaining;
  if (parsed.framing) {
    clientFraming = parsed.framing;
  }
  for (const error of parsed.errors) {
    writeResponse(null, null, error);
  }
  for (const message of parsed.messages) {
    await handleRequest(message);
  }
}
function readJsonRpcMessages(buffer) {
  const messages = [];
  const errors = [];
  let framing;
  let remaining = buffer;
  while (true) {
    const legacyHeader = /^content-length:/i.test(
      remaining.subarray(0, 16).toString("utf8")
    );
    let body = null;
    if (legacyHeader) {
      const headerEnd = remaining.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return { messages, remaining, errors, framing };
      }
      const header = remaining.slice(0, headerEnd).toString("utf8");
      const length = Number.parseInt(
        header.match(/content-length:\s*(\d+)/i)?.[1] ?? "",
        10
      );
      if (!Number.isFinite(length) || length < 0) {
        errors.push({
          code: -32600,
          message: "Invalid Content-Length header."
        });
        framing = "content-length";
        remaining = remaining.slice(headerEnd + 4);
        continue;
      }
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (remaining.byteLength < messageEnd) {
        return { messages, remaining, errors, framing };
      }
      body = remaining.slice(messageStart, messageEnd).toString("utf8");
      remaining = remaining.slice(messageEnd);
      framing = "content-length";
    } else {
      const newline = remaining.indexOf("\n");
      if (newline < 0) {
        return { messages, remaining, errors, framing };
      }
      body = remaining.slice(0, newline).toString("utf8").trim();
      remaining = remaining.slice(newline + 1);
      if (!body) {
        continue;
      }
      framing = "ndjson";
    }
    try {
      messages.push(JSON.parse(body));
    } catch {
      errors.push({ code: -32700, message: "Malformed JSON-RPC payload." });
    }
  }
}
async function handleRequest(request) {
  const response = await dispatchJsonRpcRequest(request);
  if (!response) {
    return;
  }
  writeResponse(response.id, response.result, response.error);
}
async function dispatchJsonRpcRequest(request) {
  if (request.method === "initialize") {
    return {
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: "@remembrance-ai/mcp-server",
          version: SERVER_VERSION
        },
        instructions: REMEMBRANCE_MCP_SERVER_INSTRUCTIONS
      }
    };
  }
  if (request.method === "tools/list") {
    return {
      id: request.id,
      result: {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      }
    };
  }
  if (request.method === "resources/list") {
    try {
      return {
        id: request.id,
        result: await listSkillResources(request.params?.cursor)
      };
    } catch (error) {
      return { id: request.id, error: jsonRpcErrorForToolError(error) };
    }
  }
  if (request.method === "resources/templates/list") {
    return {
      id: request.id,
      result: {
        resourceTemplates: [
          {
            uriTemplate: REMEMBRANCE_SKILL_RESOURCE_URI_TEMPLATE,
            name: "Remembrance skill",
            description: "A lightweight authorized skill-selection handle. Read it, then call invoke_skill to load the current reviewed instructions.",
            mimeType: "application/json"
          }
        ]
      }
    };
  }
  if (request.method === "resources/read") {
    try {
      return {
        id: request.id,
        result: await readSkillResource(request.params?.uri)
      };
    } catch (error) {
      return { id: request.id, error: jsonRpcErrorForToolError(error) };
    }
  }
  if (request.method === "tools/call") {
    const name = String(request.params?.name ?? "");
    const definition = tools.find((item) => item.name === name);
    if (!definition) {
      return {
        id: request.id,
        error: { code: -32602, message: `Unknown tool: ${name}` }
      };
    }
    let result;
    try {
      result = await callTool(definition, request.params?.arguments);
    } catch (error) {
      return {
        id: request.id,
        error: jsonRpcErrorForToolError(error)
      };
    }
    return {
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      }
    };
  }
  if (request.id !== void 0) {
    return {
      id: request.id,
      error: {
        code: -32601,
        message: `Method not found: ${request.method ?? "unknown"}`
      }
    };
  }
  return null;
}
function jsonRpcErrorForToolError(error) {
  const message = error instanceof Error ? error.message : "Tool call failed";
  return {
    code: isZodValidationError(error) ? -32602 : -32603,
    message
  };
}
function isZodValidationError(error) {
  return error instanceof Error && (error.name === "ZodError" || messageLooksLikeZodError(error.message));
}
function messageLooksLikeZodError(message) {
  return message.includes("Required") || message.includes("Invalid input");
}
async function callTool(definition, rawArguments) {
  const payload = definition.schema.parse(rawArguments ?? {});
  if (definition.local === "bootstrap_agent_identity") {
    return bootstrapAgentIdentity(payload);
  }
  if (definition.name === "submit_feedback") {
    return submitFeedback(payload);
  }
  if (definition.name === "submit_remembrance") {
    return submitRemembrance(payload);
  }
  return callRemembrance(definition, payload);
}
async function submitRemembrance(payload) {
  const { verified_attestation: verifiedAttestation, ...request } = payload;
  if (!verifiedAttestation) {
    return callRemembrance(mustFindTool("submit_remembrance"), request);
  }
  const skillSlug = request.skill?.slug;
  if (!skillSlug) {
    throw new Error("verified_attestation requires skill.slug.");
  }
  const evidence = {
    trace_hash: request.evidence.trace_hash ?? null,
    artifact_hashes: request.evidence.artifact_hashes ?? []
  };
  const remembrancePayload = {
    ...request,
    evidence
  };
  const attestation = await signedRemembranceAttestation(
    remembrancePayload,
    skillSlug
  );
  return callRemembrance(mustFindTool("submit_remembrance"), {
    ...remembrancePayload,
    evidence: {
      ...evidence,
      attestation
    }
  });
}
async function submitFeedback(payload) {
  const { verified_attestation: verifiedAttestation, ...request } = payload;
  if (!verifiedAttestation) {
    return callRemembrance(mustFindTool("submit_feedback"), request);
  }
  const identity = await readIdentity();
  if (!identity) {
    throw new Error(
      "No local Remembrance agent identity found. Run bootstrap_agent_identity first."
    );
  }
  const agent = request.agent ?? {
    provider: agentProviderForIdentity(identity.provider),
    agent_id: identity.subject
  };
  const evidence = {
    trace_hash: request.evidence?.trace_hash ?? null,
    artifact_hashes: request.evidence?.artifact_hashes ?? []
  };
  const lesson = request.lesson?.trim() || (request.useful ? `The ${request.skill_slug} skill was useful.` : `The ${request.skill_slug} skill was not useful.`);
  const remembrancePayload = {
    schema_version: "0.1",
    type: "skill_feedback",
    agent,
    task: {
      domain: "agent-feedback",
      summary: `Feedback for ${request.skill_slug}: ${lesson}`,
      privacy: "redacted_public"
    },
    skill: { slug: request.skill_slug },
    outcome: {
      success: request.useful,
      usefulness_rating: request.rating ?? (request.useful ? 5 : 2),
      confidence: 0.8,
      user_accepted: request.useful,
      failure_modes: []
    },
    lesson,
    suggested_update: { kind: "none" },
    evidence
  };
  const attestation = await signedRemembranceAttestation(
    remembrancePayload,
    request.skill_slug
  );
  return callRemembrance(mustFindTool("submit_feedback"), {
    ...request,
    agent,
    evidence: {
      ...evidence,
      attestation
    }
  });
}
async function signedRemembranceAttestation(remembrancePayload, skillSlug) {
  const identity = await readIdentity();
  if (!identity) {
    throw new Error(
      "No local Remembrance agent identity found. Run bootstrap_agent_identity first."
    );
  }
  const evidenceHash = attestationEvidenceHashForRemembrance(remembrancePayload);
  const challenge = await callRemembrance(
    mustFindTool("request_attestation_challenge"),
    {
      provider: identity.provider,
      source_type: "remembrance",
      agent_id: remembrancePayload.agent?.agent_id ?? remembrancePayload.agent?.id ?? identity.subject,
      subject: identity.subject,
      skill_slug: skillSlug,
      evidence_hash: evidenceHash
    }
  );
  if (challenge.ok === false) {
    throw new Error("Unable to create Remembrance attestation challenge.");
  }
  const challengeBody = challenge.body ?? {};
  const signingPayload = String(challengeBody.signing_payload_canonical ?? "");
  const signature = signPayload(
    null,
    Buffer.from(signingPayload),
    createPrivateKey(identity.private_key)
  ).toString("base64url");
  return {
    version: "v2",
    provider: identity.provider,
    challenge_id: String(challengeBody.challenge_id ?? ""),
    nonce: String(challengeBody.nonce ?? ""),
    audience: String(challengeBody.audience ?? ""),
    subject: identity.subject,
    key_id: identity.key_id,
    algorithm: "ed25519",
    issued_at: String(challengeBody.issued_at ?? ""),
    expires_at: String(challengeBody.expires_at ?? ""),
    evidence_hash: evidenceHash,
    signature
  };
}
async function bootstrapAgentIdentity(args) {
  const keyPath = identityPath(args.key_path);
  const reusedExistingIdentity = !args.force_rotate && existsSync(keyPath);
  const identity = reusedExistingIdentity ? await readIdentity(keyPath) : await createAndPersistIdentity(args, keyPath);
  if (!identity) {
    throw new Error("Unable to create or read Remembrance agent identity.");
  }
  const mismatchedFields = [];
  if (reusedExistingIdentity) {
    if (typeof args.subject === "string" && args.subject !== identity.subject) {
      mismatchedFields.push(`subject "${args.subject}"`);
    }
    if (typeof args.key_id === "string" && args.key_id !== identity.key_id) {
      mismatchedFields.push(`key_id "${args.key_id}"`);
    }
  }
  const signedAt = (/* @__PURE__ */ new Date()).toISOString();
  const proofPayload = buildAgentKeyRegistrationSigningPayload({
    provider: identity.provider,
    keyId: identity.key_id,
    publicKey: identity.public_key,
    subject: identity.subject,
    signedAt
  });
  const proofSignature = signPayload(
    null,
    Buffer.from(proofPayload),
    createPrivateKey(identity.private_key)
  ).toString("base64url");
  const registration = await callRemembrance(
    mustFindTool("register_agent_key"),
    {
      provider: identity.provider,
      key_id: identity.key_id,
      public_key: identity.public_key,
      subject: identity.subject,
      proof: {
        algorithm: "ed25519",
        signed_at: signedAt,
        signature: proofSignature
      },
      metadata: {
        registered_by: "@remembrance-ai/mcp-server"
      }
    }
  );
  return {
    key_path: keyPath,
    provider: identity.provider,
    subject: identity.subject,
    key_id: identity.key_id,
    reused_existing_identity: reusedExistingIdentity,
    ...mismatchedFields.length > 0 ? {
      warning: `An existing identity (subject "${identity.subject}", key_id "${identity.key_id}") was reused; the requested ${mismatchedFields.join(" and ")} ${mismatchedFields.length > 1 ? "were" : "was"} ignored. Pass force_rotate: true to mint a new identity.`
    } : {},
    registration
  };
}
async function createAndPersistIdentity(args, keyPath) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = String(
    publicKey.export({ type: "spki", format: "pem" })
  );
  const identity = {
    provider: args.provider ?? "other",
    subject: args.subject,
    key_id: args.key_id ?? defaultAgentKeyIdForPublicKey(publicKeyPem),
    public_key: publicKeyPem,
    private_key: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await mkdir(dirname(keyPath), { recursive: true, mode: 448 });
  await writeFile(keyPath, `${JSON.stringify(identity, null, 2)}
`, {
    mode: 384
  });
  return identity;
}
async function readIdentity(path = identityPath()) {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(await readFile(path, "utf8"));
}
async function callRemembrance(definition, rawArguments) {
  const parsed = definition.schema.parse(rawArguments ?? {});
  const payload = definition.name === "query_skills" || definition.name === "invoke_skill" ? {
    ...parsed,
    client_context: {
      ...parsed.client_context ?? {},
      surface: "mcp"
    }
  } : parsed;
  const headers = {
    "content-type": "application/json"
  };
  const apiKey = resolveApiKey();
  if (apiKey) {
    headers["x-remembrance-api-key"] = apiKey;
  }
  if (definition.name !== "bootstrap_agent_identity") {
    const economicsSession = await ensureEconomicsSessionToken().catch(
      () => null
    );
    if (economicsSession) {
      headers["x-remembrance-economics-session"] = economicsSession;
    }
  }
  const endpoint = endpointFor(definition, payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs());
  let response;
  try {
    response = await fetch(`${apiBase}${endpoint}`, {
      method: definition.method ?? "POST",
      headers,
      body: definition.method === "GET" ? void 0 : JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "API request failed"
    };
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(async () => ({
    text: await response.text().catch(() => "")
  }));
  const verifiedBody = definition.name === "get_value_proof" && response.ok ? await verifySignedValueProofWithKeyRefresh(body, fetchValueProofKeySet) : body;
  return {
    ok: response.ok,
    status: response.status,
    idempotency_status: response.headers.get("idempotency-status"),
    rate_limit_remaining: response.headers.get("x-ratelimit-remaining"),
    etag: response.headers.get("etag"),
    body: verifiedBody
  };
}
async function fetchValueProofKeySet(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cachedValueProofKeys && cachedValueProofKeys.expiresAt > now) {
    return cachedValueProofKeys.value;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs());
  try {
    const response = await fetch(
      `${apiBase}/.well-known/remembrance-value-proof-keys.json`,
      {
        headers: { accept: "application/json" },
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(
        `Value proof verification keys are unavailable (${response.status}).`
      );
    }
    const value = await response.json();
    cachedValueProofKeys = {
      value,
      expiresAt: now + valueProofKeyCacheTtlMs(response.headers)
    };
    return value;
  } finally {
    clearTimeout(timeout);
  }
}
function valueProofKeyCacheTtlMs(headers) {
  const maxAge = headers.get("cache-control")?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
  const seconds = Number(maxAge);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.trunc(seconds)) * 1e3 : 3e5;
}
function resetValueProofKeyCacheForTests() {
  cachedValueProofKeys = null;
}
function apiTimeoutMs() {
  const parsed = Number.parseInt(
    process.env.REMEMBRANCE_API_TIMEOUT_MS ?? "",
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1e4;
}
function endpointFor(definition, payload) {
  if (!definition.endpoint) {
    throw new Error(`Tool ${definition.name} has no HTTP endpoint.`);
  }
  const endpoint = definition.endpoint.replaceAll("{slug}", encodeURIComponent(String(payload.slug ?? ""))).replaceAll("{id}", encodeURIComponent(String(payload.id ?? "")));
  if (definition.method !== "GET") return endpoint;
  const params = new URLSearchParams();
  const queryKeys = definition.name === "list_skills" ? ["q", "slug", "cursor", "limit"] : ["query_id", "result_id"];
  for (const key of queryKeys) {
    const value = payload[key];
    if (typeof value === "string" && value || typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `${endpoint}?${query}` : endpoint;
}
async function listSkillResources(rawCursor) {
  const cursor = typeof rawCursor === "string" && rawCursor ? rawCursor : void 0;
  const catalog = await fetchSkillCatalog({ cursor, limit: 50 });
  return {
    resources: catalog.skills.map((skill) => ({
      uri: skill.resource_uri,
      name: skill.name,
      description: skill.summary,
      mimeType: "application/json"
    })),
    ...catalog.next_cursor ? { nextCursor: catalog.next_cursor } : {}
  };
}
async function readSkillResource(rawUri) {
  if (typeof rawUri !== "string") {
    throw new Error("resources/read requires a Remembrance skill URI.");
  }
  const slug = parseRemembranceSkillResourceUri(rawUri);
  const catalog = await fetchSkillCatalog({ slug, limit: 1 });
  const skill = catalog.skills.find((entry) => entry.slug === slug);
  if (!skill) {
    throw new Error("Skill resource is unavailable or inaccessible.");
  }
  return {
    contents: [
      {
        uri: skill.resource_uri,
        mimeType: "application/json",
        text: remembranceSkillResourceHandle(skill)
      }
    ]
  };
}
async function fetchSkillCatalog(input) {
  const response = await callRemembrance(
    mustFindTool("list_skills"),
    input
  );
  if (!response.ok) {
    throw new Error(
      `Skill catalog is unavailable${response.status ? ` (${response.status})` : ""}.`
    );
  }
  return skillCatalogResponseSchema.parse(response.body);
}
async function ensureEconomicsSessionToken() {
  const identity = await readIdentity();
  if (!identity) return null;
  const identityKey = `${identity.provider}:${identity.key_id}`;
  if (cachedEconomicsSession && cachedEconomicsSession.identityKey === identityKey && cachedEconomicsSession.expiresAt > Date.now() + 6e4) {
    return cachedEconomicsSession.token;
  }
  const challengeResponse = await directEconomicsSessionRequest({
    action: "challenge",
    provider: identity.provider,
    key_id: identity.key_id
  });
  const challenge = challengeResponse;
  if (!challenge.challenge_id || !challenge.signing_payload) return null;
  const signature = signPayload(
    null,
    Buffer.from(challenge.signing_payload),
    createPrivateKey(identity.private_key)
  ).toString("base64url");
  const exchangeResponse = await directEconomicsSessionRequest({
    action: "exchange",
    provider: identity.provider,
    key_id: identity.key_id,
    challenge_id: challenge.challenge_id,
    signature
  });
  const exchange = exchangeResponse;
  if (!exchange.session_token || !exchange.expires_at) return null;
  cachedEconomicsSession = {
    token: exchange.session_token,
    expiresAt: new Date(exchange.expires_at).getTime(),
    identityKey
  };
  return cachedEconomicsSession.token;
}
async function directEconomicsSessionRequest(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs());
  try {
    const response = await fetch(`${apiBase}/api/v1/agent/economics/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) return null;
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function mustFindTool(name) {
  const tool2 = tools.find((item) => item.name === name);
  if (!tool2) {
    throw new Error(`Missing internal tool definition: ${name}`);
  }
  return tool2;
}
function identityPath(explicit) {
  if (explicit) {
    return explicit;
  }
  if (process.env.REMEMBRANCE_AGENT_KEY_PATH) {
    return process.env.REMEMBRANCE_AGENT_KEY_PATH;
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "remembrance",
    "agent-key.json"
  );
}
function agentProviderForIdentity(provider) {
  if (provider === "codex" || provider === "cursor") {
    return provider;
  }
  if (provider === "claude_code") {
    return "claude";
  }
  return "generic";
}
function writeResponse(id, result, error) {
  process.stdout.write(formatJsonRpcResponse(id, result, error));
}
function formatJsonRpcResponse(id, result, error, framing = clientFraming) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    ...error ? { error } : { result }
  });
  if (framing === "content-length") {
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r
\r
${body}`;
  }
  return `${body}
`;
}
export {
  callTool,
  dispatchJsonRpcRequest,
  formatJsonRpcResponse,
  readJsonRpcMessages,
  resetValueProofKeyCacheForTests
};
