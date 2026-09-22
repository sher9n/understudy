/* What is known about each workload's strategies, as last read (see src/learn/explore.js). Kept in a
   module of its own so that anything which changes a workload's switch, a promotion or a switch back,
   can forget it at once without importing the learning layer that reads it. */
export const memo = new Map();
export const forgetState = (workloadId = null) => { if (workloadId) memo.delete(workloadId); else memo.clear(); };
