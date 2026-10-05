// One of the threads scripts/harness.mjs spreads its learning simulations over: runs each one it is sent and sends back
// what came of it.
import { parentPort } from 'node:worker_threads';
import { learnRates } from '../src/eval/harness.js';

parentPort.on('message', ({ id, params }) => parentPort.postMessage({ id, result: learnRates(params) }));
