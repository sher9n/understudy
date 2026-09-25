-- A model's answers in a test, kept so a page can list them exactly as the test read them (runAnswersOf in
-- src/workloadPage.js).

-- Whether an answer counted towards the model's figure (tryModel in src/eval/run.js): 1 counted, 0 left out. A
-- judgement that did not come back, or a refusal from a provider that was only busy, says nothing about the model's
-- answers, so the test leaves it out, and the answer is still kept with a score. Null on answers kept before.
ALTER TABLE eval_replays ADD COLUMN IF NOT EXISTS scored SMALLINT;

-- Which look at the model it belongs to: null (or 1) its first, on the test's own requests; 2 its second, on new
-- requests it had never seen (lookAgain in src/eval/run.js), which a model has to pass as well before anything
-- switches. Second looks kept no answers before this.
ALTER TABLE eval_replays ADD COLUMN IF NOT EXISTS look SMALLINT;
