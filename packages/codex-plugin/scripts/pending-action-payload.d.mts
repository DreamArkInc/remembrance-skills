export type PendingActionPayloadInput = {
  action_id: string;
  ledger: string;
};

export type PendingActionPayloadResult = {
  status:
    | "retrieved"
    | "not_found"
    | "refused"
    | "unavailable"
    | "not_retained";
  action_id: string;
  ledger: string;
  submitted: false;
  local_only: true;
  guidance: string;
  [field: string]: unknown;
};

export function readPendingActionPayload(
  input: PendingActionPayloadInput,
  env: NodeJS.ProcessEnv,
  options: {
    readKey: (source: "os_keychain" | "mode_0600_file") => Promise<Buffer>;
  },
): Promise<PendingActionPayloadResult>;

export type RetainedKeyConsumerInventory = {
  consumers: {
    total: number;
    kinds: {
      private_lesson: number;
      private_skill: number;
      remembrance_followup: number;
      capture_next_action: number;
    };
    sources: { os_keychain: number; mode_0600_file: number };
  };
  incomplete: boolean;
  reasons: {
    unclassified: number;
    unlisted: number;
    areas: string[];
    causes: Record<
      "bounded" | "unreadable" | "unclassified" | "unlisted",
      { count: number; areas: string[] }
    >;
  };
  unretained: { count: number; kinds: string[] };
};

export const INVENTORY_LIMITS: Readonly<{
  ledgers: number;
  files: number;
}>;

export function inventoryRetainedKeyConsumers(
  env: NodeJS.ProcessEnv,
  options?: {
    limits?: { ledgers: number; files: number };
    lanes?: string[];
    homeDirectory?: string;
  },
): RetainedKeyConsumerInventory;

export const RESTORE_ORIGINAL_KEY: string;

export function retainedKeyHoldCodes(
  inventory: RetainedKeyConsumerInventory,
): string[];

export function normalizeRetainedKeyHoldCodes(value: unknown): string[] | null;

export function retainedKeyHoldRemediation(codes: readonly string[]): string;

export function retainedRootsUsable(
  env: NodeJS.ProcessEnv,
  homeDirectory?: string,
  options?: { retained?: boolean },
): boolean;

export function retainedLedgerRoot(
  env: NodeJS.ProcessEnv,
  homeDirectory?: string,
): string;

export function resupplyPayloadDigest(payload: unknown): string | null;

export function sealResupplyPayload(
  obligation: { id: string; payload_digest: string },
  payload: unknown,
  key: { key: Buffer; source: "os_keychain" | "mode_0600_file" },
): {
  version: string;
  algorithm: "aes-256-gcm";
  key_source: "os_keychain" | "mode_0600_file";
  nonce: string;
  ciphertext: string;
  auth_tag: string;
};
