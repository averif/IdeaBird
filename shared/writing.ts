// Pro: custom tone and writing instructions. Shared by the Settings page and the
// server, which validates them and adds them to the writer's prompt.

export interface Tone {
  id: string;
  label: string;
  /** What the writer model is told, and the hint shown under the choice. */
  description: string;
}

export const TONES: Tone[] = [
  { id: 'default', label: 'IdeaBird default', description: 'Sharp, insightful and human. No extra tone applied.' },
  { id: 'casual', label: 'Casual', description: 'Relaxed and conversational, with contractions, like talking to a friend.' },
  { id: 'professional', label: 'Professional', description: 'Polished, credible and measured, without corporate jargon.' },
  { id: 'bold', label: 'Bold', description: 'Confident and opinionated. Short, punchy sentences and strong claims backed by the facts.' },
  { id: 'witty', label: 'Witty', description: 'Clever and playful, with light humor that never undercuts the point.' },
  { id: 'educational', label: 'Educational', description: 'Clear and explanatory. Teaches the reader why it matters, step by step.' },
  { id: 'storyteller', label: 'Storyteller', description: 'Narrative: sets the scene, builds tension, lands the insight.' },
];

export const DEFAULT_TONE = 'default';
export const INSTRUCTIONS_MAX_LENGTH = 500;

export function toneById(id: string): Tone | undefined {
  return TONES.find((tone) => tone.id === id);
}
