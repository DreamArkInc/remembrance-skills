export type FeedbackDenialInput =
  | {
      tool: "submit_query_feedback";
      query_id: string;
      reason: "host_policy_denied";
    }
  | {
      tool: "submit_feedback";
      query_id: string;
      result_id: string;
      reason: "host_policy_denied";
    };

export type FeedbackDenialAcknowledgement = {
  status: "acknowledged_host_denial";
  acknowledged: true;
  submitted: false;
  local_only: true;
  already_acknowledged: boolean;
  expires_at: string;
};

export function acknowledgeFeedbackDenial(
  input: FeedbackDenialInput,
  env?: NodeJS.ProcessEnv,
): FeedbackDenialAcknowledgement;

export function feedbackDenialAcknowledged(
  input: FeedbackDenialInput,
  env?: NodeJS.ProcessEnv,
): boolean;
