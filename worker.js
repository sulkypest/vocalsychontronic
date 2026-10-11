// Runs Rhubarb (WebAssembly build) off the main thread so the page stays responsive.
import createModule from "./vendor/rhubarb/rhubarb.js";

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    const base = new URL("./vendor/rhubarb/", import.meta.url);
    modulePromise = createModule({
      locateFile: (path) => new URL(path, base).href,
      print: () => {},
      printErr: () => {},
      setStatus: (s) => {
        const m = /\((\d+)\/(\d+)\)/.exec(s || "");
        if (m) self.postMessage({ progress: "download", loaded: +m[1], total: +m[2] });
      },
    });
  }
  return modulePromise;
}

self.onmessage = async (e) => {
  const { id, type, pcm, dialog } = e.data;
  try {
    if (type === "warmup") {
      await getModule();
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === "analyse") {
      const mod = await getModule();
      self.postMessage({ id, progress: "analysing" });
      const result = mod.getLipSync(new Uint8Array(pcm), dialog || "");
      // Embind may hand back a plain object or a wrapped value; normalise it.
      const cues = Array.from(result.mouthCues, (c) => ({
        start: Number(c.start),
        end: Number(c.end),
        value: String(c.value),
      }));
      self.postMessage({ id, ok: true, cues });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
