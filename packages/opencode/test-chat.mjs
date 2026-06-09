import { getLlama, LlamaChatSession } from "node-llama-cpp";
const llama = await getLlama("lastBuild", { logLevel: "warn" });
const model = await llama.loadModel({ modelPath: "D:\\.flashcode\\models\\Jackrong\\Qwopus3.6-27B-v2-MTP-GGUF\\Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf", gpuLayers: 99 });
const ctx = await model.createContext({ contextSize: 4096 });
const session = new LlamaChatSession({ contextSequence: ctx.getSequence() });

// Test with more tokens and onTextChunk 
let chunks = [];
const result = await session.promptWithMeta("What is 2+2? Answer briefly.", { 
  maxTokens: 500,
  onTextChunk(chunk) {
    chunks.push(chunk);
  }
});

console.log("=== RESPONSE STRUCTURE ===");
for (const item of result.response) {
  if (typeof item === "string") {
    console.log("  text: " + JSON.stringify(item));
  } else if (item.type === "segment") {
    console.log("  segment type=" + item.segmentType + " ended=" + item.ended);
    console.log("  segment text: " + JSON.stringify(item.text.substring(0, 200)));
  }
}
console.log("responseText: " + JSON.stringify(result.responseText));
console.log("stopReason: " + result.stopReason);
console.log("onTextChunk chunks: " + chunks.length);
if (chunks.length > 0) {
  console.log("  first: " + JSON.stringify(chunks[0]));
  console.log("  last: " + JSON.stringify(chunks[chunks.length - 1]));
  console.log("  joined: " + JSON.stringify(chunks.join("").substring(0, 200)));
}

process.exit(0);
