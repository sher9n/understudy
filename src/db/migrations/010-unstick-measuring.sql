-- Let go of workloads that are not actually measuring.
--
-- Pressing Measure now used to mark a workload "Measuring" and queue a job that declined a
-- moment later, so the mark stayed for ever and the screen said something that had stopped
-- being true within seconds. The cause is fixed; these are the rows it left behind.
UPDATE workloads SET status = CASE WHEN floor_pct IS NULL THEN 'new' ELSE 'certified' END,
                     updated_at = EXTRACT(EPOCH FROM now()) * 1000
 WHERE status = 'measuring'
   AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = workloads.id AND r.status = 'running');
