export const WINDOWS_LOCAL_RECOVERY_POWERSHELL: string;
export type WindowsLocalRecoveryStep = {
  code: "restore_windows_private_permissions";
  execution: "normal_host_shell";
  executable: string;
  arguments: string[];
  environment: { REMEMBRANCE_WINDOWS_RECOVERY_TARGET: string };
  program: string;
  instructions: string;
  on_success: { tool: "get_connection_status" | "bootstrap_agent_identity"; arguments: Record<string, never> };
  on_refusal: { code: "owner_review_required"; instructions: string };
  history_limit: string;
};
export function windowsLocalRecoveryStep(path: string, kind: "file" | "directory", tool: "get_connection_status" | "bootstrap_agent_identity"): WindowsLocalRecoveryStep;
