-- "Keeps what matters", the third way of judging written answers (3 Oct 2026; src/eval/keeps.js).
--
-- The customer's model's third answer to a sampled request, asked only when a test holds answers to keeping what matters:
-- read against the facts its other two answers keep, it is how often the customer's own model misses something, which sets
-- the bar. JSON of the response, as ref_a_json and ref_b_json are; null on every other test.
ALTER TABLE eval_samples ADD COLUMN IF NOT EXISTS ref_c_json TEXT;

-- What every answer to that request was held to: { facts: [{ say, figures, weight }], detail: [{ say, weight }], dropped }, the
-- facts both of the customer's answers state that matter (weight 0 to 3, how much Jev reads each as mattering), the
-- supporting detail they also share, which nobody is held to, and the ones listed that the reading could not find in both.
-- So a test's page can show, request by request, what an answer had to keep. Null on every other test.
ALTER TABLE eval_samples ADD COLUMN IF NOT EXISTS facts_json TEXT;
