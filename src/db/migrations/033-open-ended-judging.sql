-- How a workload's answers are judged when another model is tested on them (25 Sep 2026): 'auto' lets each test
-- choose, "at least as good" for open-ended writing (a poem, a story, a slogan) and "the same answer" for everything
-- else; 'same' always asks for the same answers as the original model; 'quality' always asks for answers at least as
-- good. Null is 'auto'.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS judge_mode TEXT;

-- What the judge said about one answer, as the page shows it request by request (runAnswersOf in src/workloadPage.js):
-- held to "at least as good", its two readings, one each way round, and a requirement of the instruction it broke.
-- JSON; null where there was no reading, and on answers kept before.
ALTER TABLE eval_replays ADD COLUMN IF NOT EXISTS readings TEXT;

-- How a background answer was read ('agreement' for "the same answer", 'quality' for "at least as good"), the way the
-- workload's newest measurement judged (barOf in src/learn/control.js). Only readings made the way the workload is judged
-- now count towards what the background answers show; null is 'agreement', how every one kept before was read.
ALTER TABLE shadow_runs ADD COLUMN IF NOT EXISTS yardstick TEXT;
