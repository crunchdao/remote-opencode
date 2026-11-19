import type { QuestionRequest } from '../types/index.js';
import { getAutoAnswerQuestions } from './configStore.js';
import * as sessionManager from './sessionManager.js';

const QUESTION_LIMIT = 300;

// A request can be seen twice (its event, then the pending list when a session starts being followed).
const answeredRequestIds = new Set<string>();

/**
 * `autoAnswerQuestions`: answers the request with the configured text and returns the notice to post in the thread.
 * Null when the option is off, or the request was already answered.
 */
export async function autoAnswerQuestion(port: number, request: QuestionRequest): Promise<string | null> {
  const answer = getAutoAnswerQuestions();
  if (!answer || answeredRequestIds.has(request.id)) return null;

  answeredRequestIds.add(request.id);
  try {
    await sessionManager.replyToQuestion(port, request.id, request.questions.map(() => [answer]));
  } catch (error) {
    answeredRequestIds.delete(request.id);
    throw error;
  }

  return describeAnsweredQuestion(request);
}

/** Answers the questions of the session that were asked while nobody listened (before the bot followed it). */
export async function autoAnswerPendingQuestions(port: number, sessionId: string): Promise<string[]> {
  if (!getAutoAnswerQuestions()) return [];

  const notices: string[] = [];
  for (const request of await sessionManager.getPendingQuestions(port)) {
    if (request.sessionID !== sessionId) continue;

    const notice = await autoAnswerQuestion(port, request);
    if (notice) notices.push(notice);
  }
  return notices;
}

export function describeAnsweredQuestion(request: QuestionRequest): string {
  const asked = request.questions.map((question) => question.question).join(' / ');
  const shortened = asked.length > QUESTION_LIMIT ? `${asked.slice(0, QUESTION_LIMIT)}…` : asked;

  return `-# ❓ the agent asked "${shortened.replace(/\s+/g, ' ')}", answered automatically (\`autoAnswerQuestions\`)`;
}
