import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/configStore.js');
vi.mock('../services/sessionManager.js');

import { autoAnswerQuestion, autoAnswerPendingQuestions } from '../services/questionService.js';
import * as configStore from '../services/configStore.js';
import * as sessionManager from '../services/sessionManager.js';
import type { QuestionRequest } from '../types/index.js';

let requestCount = 0;

function request(sessionID = 'session-1'): QuestionRequest {
  requestCount++;
  return {
    id: `question-${requestCount}`,
    sessionID,
    questions: [
      { question: 'Which model should I try next?', options: [{ label: 'LightGBM' }, { label: 'CatBoost' }] },
      { question: 'Submit now?' },
    ],
  };
}

describe('questionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionManager.replyToQuestion).mockResolvedValue(undefined);
  });

  it('does nothing when autoAnswerQuestions is not set', async () => {
    vi.mocked(configStore.getAutoAnswerQuestions).mockReturnValue(null);

    expect(await autoAnswerQuestion(14097, request())).toBeNull();
    expect(sessionManager.replyToQuestion).not.toHaveBeenCalled();
  });

  it('answers every question of the request with the configured text, once', async () => {
    vi.mocked(configStore.getAutoAnswerQuestions).mockReturnValue('Decide yourself.');
    const asked = request();

    const notice = await autoAnswerQuestion(14097, asked);
    const again = await autoAnswerQuestion(14097, asked);

    expect(sessionManager.replyToQuestion).toHaveBeenCalledTimes(1);
    expect(sessionManager.replyToQuestion).toHaveBeenCalledWith(14097, asked.id, [['Decide yourself.'], ['Decide yourself.']]);
    expect(notice).toBe('-# ❓ the agent asked "Which model should I try next? / Submit now?", answered automatically (`autoAnswerQuestions`)');
    expect(again).toBeNull();
  });

  it('tries again later when the reply failed', async () => {
    vi.mocked(configStore.getAutoAnswerQuestions).mockReturnValue('Decide yourself.');
    vi.mocked(sessionManager.replyToQuestion).mockRejectedValueOnce(new Error('connection refused'));
    const asked = request();

    await expect(autoAnswerQuestion(14097, asked)).rejects.toThrow('connection refused');
    expect(await autoAnswerQuestion(14097, asked)).not.toBeNull();
  });

  it('answers the pending questions of the session only', async () => {
    vi.mocked(configStore.getAutoAnswerQuestions).mockReturnValue('Decide yourself.');
    const mine = request('session-1');
    vi.mocked(sessionManager.getPendingQuestions).mockResolvedValue([mine, request('session-2')]);

    const notices = await autoAnswerPendingQuestions(14097, 'session-1');

    expect(notices).toHaveLength(1);
    expect(sessionManager.replyToQuestion).toHaveBeenCalledTimes(1);
    expect(sessionManager.replyToQuestion).toHaveBeenCalledWith(14097, mine.id, expect.any(Array));
  });
});
