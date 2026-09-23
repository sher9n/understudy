import { parentPort, workerData } from 'node:worker_threads';

/* Counts a PDF's pages, in a thread of its own. The parser unpacks compressed streams in full and walks
   the page tree as the file describes it, so a small file built to make it work (a tree that lists
   each level twice, a stream that unpacks to a gigabyte) runs for seconds or fills memory. Here that
   only ever stops this thread, which the caller times out and ends, never the server. */
const { PDFDocument } = await import('pdf-lib');
try {
  const doc = await PDFDocument.load(workerData.bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  parentPort.postMessage({ ok: true, pages: doc.getPageCount() });
} catch (err) {
  parentPort.postMessage({ ok: false, reason: String(err?.message || err).slice(0, 200) });
}
