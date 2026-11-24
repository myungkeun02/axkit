import { EN_QUESTIONS } from './questions-en.js';
import { KO_QUESTIONS } from './questions-ko.js';

export interface InterviewOption {
  id: string;
  label: string;
  /** The fact stored when this option is chosen, in the assistant's language. */
  fact: string;
}

export interface InterviewQuestion {
  id: string;
  text: string;
  options: readonly InterviewOption[];
}

export const SKIP_OPTION = 'skip';

export function interviewQuestions(language: string): readonly InterviewQuestion[] {
  return language === 'en' ? EN_QUESTIONS : KO_QUESTIONS;
}
