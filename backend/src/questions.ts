import { createHash } from 'node:crypto';
import { z } from 'zod';
import { QUESTION_OUTPUT_CONTRACT_VERSION, QUESTION_PROMPT_VERSION, QUESTION_SYSTEM_PROMPT, buildQuestionUserMessage } from './prompts.js';
import { getConfiguredAIModel, getOpenRouterConfiguration, OpenRouterError, requestOpenRouterText, type OpenRouterTextRequest, type OpenRouterUsage } from './openrouter.js';
import type { Call, CallStageResult } from './types.js';

const RecommendationSchema = z.object({
  question: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(500),
  intent: z.string().trim().min(1).max(500),
  priority: z.enum(['high', 'medium', 'low']),
}).strict();

export const QuestionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), questions: z.array(RecommendationSchema).length(3) }).strict(),
  z.object({ status: z.literal('insufficient_context'), questions: z.array(z.never()).length(0) }).strict(),
  z.object({ status: z.literal('no_recommendation'), questions: z.array(z.never()).length(0) }).strict(),
]);

export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;
export type QuestionGenerationResult = QuestionResponse & { source: 'openrouter' | 'fallback' };

export const STAGE_NAMES = ['Opening', 'Purpose', 'Permission', 'Their Business', 'Their Need', 'Objection', 'Next Step', 'Close'] as const;

type QuestionLogEvent = {
  event: 'ai_questions_generated' | 'ai_questions_fallback';
  provider: 'openrouter';
  task: 'questions';
  model: string;
  duration_ms: number;
  reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};
type QuestionLogger = (event: QuestionLogEvent) => void;

function usageLogFields(usage?: OpenRouterUsage) {
  return {
    ...(usage?.prompt_tokens === undefined ? {} : { input_tokens: usage.prompt_tokens }),
    ...(usage?.completion_tokens === undefined ? {} : { output_tokens: usage.completion_tokens }),
    ...(usage?.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
  };
}

function logQuestionEvent(event: QuestionLogEvent, logger?: QuestionLogger) {
  try {
    (logger ?? ((entry) => {
      const serialized = JSON.stringify(entry);
      if (entry.event === 'ai_questions_generated') console.info(serialized);
      else console.warn(serialized);
    }))(event);
  } catch {
    // Diagnostics do not change the recommendation result.
  }
}

export function getQuestionContextHash(call: Call, stages: CallStageResult[], stageNumber: number) {
  const contents = buildQuestionUserMessage(call, stages, stageNumber, STAGE_NAMES[stageNumber - 1] ?? `Stage ${stageNumber}`);
  return createHash('sha256').update(JSON.stringify({
    prompt_version: QUESTION_PROMPT_VERSION,
    output_contract_version: QUESTION_OUTPUT_CONTRACT_VERSION,
    provider: process.env.AI_PROVIDER?.trim() || 'openrouter',
    model: getConfiguredAIModel(),
    contents,
  })).digest('hex');
}

function questionRefused(call: Call, stages: CallStageResult[]) {
  if (call.status === 'completed' || call.do_not_call_confirmed || call.final_outcome === 'do_not_call' || call.final_outcome === 'not_interested') return true;
  return stages.some((stage) => stage.stage_number === 3 && stage.structured_result.interaction === 'clear_no');
}

function latestRecordedResponse(stages: CallStageResult[]) {
  const responses = [...stages].sort((left, right) => right.stage_number - left.stage_number)
    .flatMap((stage) => [...(stage.questions ?? [])].sort((left, right) => right.position - left.position)
      .filter((question) => question.asked && question.response?.trim())
      .map((question) => ({ stage, question, response: question.response!.trim() })));
  return responses[0];
}

function makeRecommendation(question: string, reason: string, intent: string, priority: 'high' | 'medium' | 'low') {
  return { question, reason, intent, priority };
}

export function fallbackQuestions(call: Call, stages: CallStageResult[], stageNumber: number): QuestionResponse {
  if (questionRefused(call, stages) || stageNumber === 8) return { status: 'no_recommendation', questions: [] };

  const current = stages.find((stage) => stage.stage_number === stageNumber);
  const interaction = current?.structured_result.interaction;
  const currentFlags = current?.structured_result.flags && typeof current.structured_result.flags === 'object'
    ? current.structured_result.flags as Record<string, unknown> : {};
  const latest = latestRecordedResponse(stages);
  const currentNote = current?.notes?.trim();
  const recordedNeed = current?.structured_result.need;
  const recordedObjection = current?.structured_result.objection;
  const hasContext = Boolean(
    call.call_purpose?.trim() || call.initial_context?.trim() || latest
    || (typeof recordedNeed === 'string' && recordedNeed.trim())
    || (typeof recordedObjection === 'string' && recordedObjection.trim())
    || stages.some((stage) => Boolean(stage.notes?.trim()) || Object.values(stage.structured_result).some((value) => typeof value === 'string' && value.trim())
      || (stage.structured_result.flags && typeof stage.structured_result.flags === 'object' && Object.values(stage.structured_result.flags).some(Boolean))),
  );
  if (!hasContext) return { status: 'insufficient_context', questions: [] };

  let questions: QuestionResponse['questions'] = [];
  if (stageNumber === 1) {
    if (currentFlags.poor_line === true) {
      questions = [
        makeRecommendation('Would you like me to repeat the last part?', 'The opening stage flags a poor line.', 'Check whether the prospect wants a repeat.', 'high'),
        makeRecommendation('Can you hear me clearly now?', 'Confirms whether the audio issue is still present.', 'Check line quality.', 'medium'),
        makeRecommendation('Would another time be easier if the line stays unclear?', 'Offers an alternative without assuming the call should continue.', 'Ask whether a callback is preferred.', 'low'),
      ];
    } else if (currentFlags.language_handoff === true) {
      questions = [
        makeRecommendation('Would you prefer to continue in another language?', 'The opening stage records a language handoff flag.', 'Confirm the prospect’s language preference.', 'high'),
        makeRecommendation('Is there someone who can help us continue in your preferred language?', 'Offers a language handoff without assuming who is available.', 'Ask whether language support is wanted.', 'medium'),
        makeRecommendation('Would you rather arrange a time when language support is available?', 'Provides an option to pause the call.', 'Check whether a supported callback is preferred.', 'low'),
      ];
    } else if (interaction === 'cant_talk_now') {
      questions = [
        makeRecommendation('Would you prefer that I call back at a specific time?', 'The opening stage records that the prospect could not talk now.', 'Ask whether a callback is wanted and when.', 'high'),
        makeRecommendation('Would later today or another day work better, if you would like a callback?', 'Offers timing choices without assuming the prospect wants another call.', 'Clarify a preferred callback window.', 'medium'),
        makeRecommendation('Would you rather I not call back?', 'Makes declining further contact explicit and easy.', 'Confirm whether any callback is welcome.', 'low'),
      ];
    } else if (interaction === 'wrong_number') return { status: 'no_recommendation', questions: [] };
    else if (interaction === 'reception') {
      if (typeof current?.structured_result.referral_details !== 'string' || !current.structured_result.referral_details.trim()) return { status: 'insufficient_context', questions: [] };
      const anchor = current.structured_result.referral_details.trim().slice(0, 90);
      questions = [
        makeRecommendation(`You mentioned “${anchor}.” Is there a suitable way to reach that person?`, 'Follows the referral information saved in the opening stage.', 'Clarify the contact route.', 'high'),
        makeRecommendation('Would you prefer to pass along my details instead?', 'Offers an alternative without assuming a transfer is possible.', 'Check the preferred referral method.', 'medium'),
        makeRecommendation('Is there anything else I should know before I follow up?', 'Invites relevant context from the person who answered.', 'Capture any useful referral guidance.', 'low'),
      ];
    }
    else if (!call.contact_name && !call.contact_role) return { status: 'insufficient_context', questions: [] };
    else questions = [
      makeRecommendation('Am I speaking with the person who handles this area?', 'Checks whether the contact is appropriate before going further.', 'Confirm the right contact.', 'high'),
      makeRecommendation('Would you have a brief moment to hear why I called?', 'Makes space for the prospect to decide whether to continue.', 'Check availability.', 'medium'),
      makeRecommendation('If this is not your area, who would be best to speak with?', 'Uses the recorded role context to avoid assuming responsibility.', 'Confirm the right contact path.', 'low'),
    ];
  } else if (stageNumber === 2) {
    const confusion = ['asked_what_we_do', 'asked_why_free', 'asked_source_of_number'].includes(String(interaction));
    questions = confusion ? [
      makeRecommendation('Which part would be most useful for me to clarify first?', 'The saved purpose-stage result shows a question about the call.', 'Identify the specific point that is unclear.', 'high'),
      makeRecommendation('Would a shorter explanation of the reason for my call help?', 'Offers a concise clarification without repeating the full pitch.', 'Check whether a brief clarification is wanted.', 'medium'),
      makeRecommendation('Would you prefer I explain how I got your details, or leave it there?', 'Addresses the recorded source-of-number question and leaves room to stop.', 'Clarify the concern or end the discussion.', 'low'),
    ] : [
      makeRecommendation('What would help you decide whether this call is relevant to your work?', 'Connects the stated call purpose to the prospect’s own context.', 'Clarify relevance.', 'high'),
      makeRecommendation('Is there a part of the reason for my call that I should explain more clearly?', 'Invites a specific clarification instead of asking a vague check-in.', 'Identify what needs clarification.', 'medium'),
      makeRecommendation('Would you like me to keep this brief, or would another time be better?', 'Gives the prospect control over the length or timing of the conversation.', 'Check preferred timing.', 'low'),
    ];
  } else if (stageNumber === 3) {
    if (interaction === 'clear_no') return { status: 'no_recommendation', questions: [] };
    if (interaction === 'call_later' || interaction === 'cant_talk_now') return { status: 'no_recommendation', questions: [] };
    if (interaction === 'continued_without_yes') {
      questions = [
        makeRecommendation('Would you like to continue the conversation now?', 'The saved stage says explicit permission was not established.', 'Ask for clear permission.', 'high'),
        makeRecommendation('Would you prefer to stop here?', 'Offers an unpressured option to end the conversation.', 'Confirm whether to continue.', 'medium'),
        makeRecommendation('Would another time work better for you?', 'A neutral alternative if the prospect does not want to continue now.', 'Check whether a later time is preferred.', 'low'),
      ];
    } else {
      questions = [
        makeRecommendation('Is now still a good time to continue?', 'Checks current availability before moving into business questions.', 'Confirm permission to continue.', 'high'),
        makeRecommendation('Would you rather keep this brief?', 'Lets the prospect set a comfortable limit for the conversation.', 'Understand time constraints.', 'medium'),
        makeRecommendation('Is there anything you would prefer I clarify before we continue?', 'Allows the prospect to raise uncertainty before the discussion moves on.', 'Identify an immediate concern.', 'low'),
      ];
    }
  } else if (stageNumber === 4 && (latest || currentNote)) {
    const anchor = (latest?.response ?? currentNote ?? '').replace(/\s+/g, ' ').slice(0, 100);
    questions = [
      makeRecommendation(latest ? `You mentioned “${anchor}.” What part of that is most central to your role?` : `A caller note records “${anchor}.” Is there more context about this part of the work?`, latest ? 'Grounds the follow-up in the prospect’s recorded answer.' : 'Uses a caller note as a prompt to clarify the saved context.', 'Understand their role in the described work.', 'high'),
      makeRecommendation('Who else is usually involved in that part of the process?', 'Follows the recorded business context without assuming a problem.', 'Understand the people involved.', 'medium'),
      makeRecommendation('Is there another part of the process that would be useful for me to understand?', 'Invites more context without presuming a challenge.', 'Complete the business context.', 'low'),
    ];
  } else if (stageNumber === 5 && ((typeof recordedNeed === 'string' && recordedNeed.trim()) || currentNote)) {
    const anchor = (typeof recordedNeed === 'string' && recordedNeed.trim() ? recordedNeed : currentNote ?? '').replace(/\s+/g, ' ').slice(0, 90);
    questions = [
      makeRecommendation(typeof recordedNeed === 'string' && recordedNeed.trim() ? `You mentioned “${anchor}.” What would a better result look like for you?` : `A caller note records “${anchor}.” Does that accurately capture the result you want?`, 'Builds on the saved stage information while checking that it reflects the prospect’s own view.', 'Clarify the prospect’s desired outcome.', 'high'),
      makeRecommendation('Which part of that would you want to address first?', 'Helps prioritize only the need the prospect has stated.', 'Understand the prospect’s priority.', 'medium'),
      makeRecommendation('How are you handling that today?', 'Clarifies the current approach to the recorded need.', 'Understand the current process.', 'low'),
    ];
  } else if (stageNumber === 6 && ((typeof recordedObjection === 'string' && recordedObjection.trim()) || currentNote)) {
    const anchor = (typeof recordedObjection === 'string' && recordedObjection.trim() ? recordedObjection : currentNote ?? '').replace(/\s+/g, ' ').slice(0, 90);
    questions = [
      makeRecommendation(typeof recordedObjection === 'string' && recordedObjection.trim() ? `You mentioned “${anchor}.” What part of that concern should I understand first?` : `A caller note records “${anchor}.” Is there a specific concern the prospect wants addressed?`, 'Acknowledges saved information and asks one neutral clarification.', 'Understand the prospect’s concern.', 'high'),
      makeRecommendation('Would you prefer to leave the conversation here?', 'Keeps the prospect in control and avoids pressing after a concern.', 'Confirm whether the prospect wants to continue.', 'medium'),
      makeRecommendation('Is there anything you would like me to clarify before we stop?', 'Offers clarification without arguing or assuming the concern can be overcome.', 'Check whether clarification is wanted.', 'low'),
    ];
  } else if (stageNumber === 7 && ['time_agreed', 'agreed_to_receive', 'referred'].includes(String(interaction))) {
    return { status: 'no_recommendation', questions: [] };
  } else if (stageNumber === 7 && interaction === 'nothing_agreed') {
    return { status: 'no_recommendation', questions: [] };
  } else if (stageNumber === 7 && (latest || currentNote)) {
    questions = [
      makeRecommendation('What, if anything, would be useful as a next step for you?', 'Uses the saved conversation context while leaving room for no further action.', 'Establish the prospect’s preference.', 'high'),
      makeRecommendation('Would you prefer to leave things here for now?', 'Avoids treating interest or politeness as agreement.', 'Confirm whether any next step is wanted.', 'medium'),
      makeRecommendation('Is there anything you would want clarified before deciding?', 'Lets the prospect identify an open question without assuming commitment.', 'Identify unresolved information.', 'low'),
    ];
  }

  if (questions.length !== 3) return { status: 'insufficient_context', questions: [] };
  const asked = new Set(stages.flatMap((stage) => (stage.questions ?? []).filter((question) => question.asked).map((question) => question.question_text.trim().toLowerCase())));
  const distinct = questions.filter((question) => !asked.has(question.question.trim().toLowerCase()));
  return distinct.length === 3 ? { status: 'ok', questions: distinct } : { status: 'insufficient_context', questions: [] };
}

function parseQuestionResponse(text: string | null | undefined): QuestionResponse {
  if (!text) throw new Error('empty_response');
  const parsed: unknown = JSON.parse(text);
  return QuestionResponseSchema.parse(parsed);
}

export async function generateLiveQuestions(
  call: Call,
  stages: CallStageResult[],
  stageNumber: number,
  options: { apiKey?: string; model?: string; fetch?: typeof fetch; logger?: QuestionLogger; request?: (input: OpenRouterTextRequest) => Promise<string | null | undefined> } = {},
): Promise<QuestionGenerationResult> {
  const fallback = fallbackQuestions(call, stages, stageNumber);
  if (fallback.status === 'no_recommendation') return { ...fallback, source: 'fallback' };

  const startedAt = Date.now();
  let model = options.model?.trim() || process.env.OPENROUTER_MODEL?.trim() || 'unconfigured';
  const contents = buildQuestionUserMessage(call, stages, stageNumber, STAGE_NAMES[stageNumber - 1] ?? `Stage ${stageNumber}`);
  try {
    const configuration = getOpenRouterConfiguration(process.env, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    model = configuration.model;
    const request = { ...configuration, systemInstruction: QUESTION_SYSTEM_PROMPT, contents, responseMimeType: 'application/json' };
    const response = options.request
      ? { text: await options.request(request), usage: undefined }
      : await requestOpenRouterText(request, options.fetch);
    const result = parseQuestionResponse(response.text);
    logQuestionEvent({ event: 'ai_questions_generated', provider: 'openrouter', task: 'questions', model, duration_ms: Date.now() - startedAt, ...usageLogFields(response.usage) }, options.logger);
    return { ...result, source: 'openrouter' };
  } catch (error) {
    const reason = error instanceof OpenRouterError ? error.category
      : error instanceof SyntaxError ? 'invalid_json'
        : error instanceof z.ZodError ? 'schema_validation_failure' : 'invalid_or_failed_response';
    const providerStatus = error instanceof OpenRouterError ? error.status : undefined;
    logQuestionEvent({ event: 'ai_questions_fallback', provider: 'openrouter', task: 'questions', model, duration_ms: Date.now() - startedAt, reason, ...(providerStatus === undefined ? {} : { provider_status: providerStatus }) }, options.logger);
    return { ...fallback, source: 'fallback' };
  }
}
