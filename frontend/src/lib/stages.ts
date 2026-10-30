import type { StageDefinition } from './types';

export const STAGES: StageDefinition[] = [
  {
    number: 1,
    title: 'Opening',
    objective: 'Confirm the right person and identify yourself.',
    guidance: 'Check whether the contact is the right person, a receptionist, or an intermediary.',
    questions: ['Who am I speaking with?', 'Can I confirm the role or team?']
  },
  {
    number: 2,
    title: 'Purpose',
    objective: 'Explain why you are calling in a clear, brief way.',
    guidance: 'Keep the purpose concise and avoid pitching too early.',
    questions: ['Why are you calling today?', 'What prompted this conversation?']
  },
  {
    number: 3,
    title: 'Permission',
    objective: 'Ask whether it is appropriate to continue.',
    guidance: 'Permission must be explicit; continued conversation is not enough to infer consent.',
    questions: ['Is now a good time to continue?', 'Would you prefer to continue now or schedule a follow-up?']
  },
  {
    number: 4,
    title: 'Their Business',
    objective: 'Understand the prospect’s business context before presenting a solution.',
    guidance: 'Ask about the company, priorities, customers, and relevant responsibilities.',
    questions: ['What does the business do?', 'How are you involved in the work?']
  },
  {
    number: 5,
    title: 'Their Need',
    objective: 'Capture the prospect’s needs in their own words.',
    guidance: 'Record direct quotes when useful and clearly separate them from paraphrased notes.',
    questions: ['What challenge are you trying to solve?', 'What matters most to you right now?']
  },
  {
    number: 6,
    title: 'Objection',
    objective: 'Understand hesitation, refusal, or competing priorities.',
    guidance: 'Document the actual objection and the caller’s response without assuming it must be overcome.',
    questions: ['What is the main reason this is not a fit right now?', 'What would need to be true for this to be relevant?']
  },
  {
    number: 7,
    title: 'Next Step',
    objective: 'Confirm the agreed action and responsibilities.',
    guidance: 'Only record a next step if it was actually agreed during the call.',
    questions: ['What is the agreed next step?', 'Who will take action and by when?']
  },
  {
    number: 8,
    title: 'Close',
    objective: 'End the conversation clearly and document the real outcome.',
    guidance: 'Record the final outcome honestly, including uncertainty or a lack of clarity.',
    questions: ['What was the final result of the call?', 'Was there a follow-up or meeting agreed?']
  }
];
