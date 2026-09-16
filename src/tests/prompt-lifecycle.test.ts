import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlmAcpAgent } from "../protocol/agent.js";
import { preprocessImageBlocks } from "../protocol/image-preprocessor.js";
import { SessionStore } from "../protocol/session-store.js";
import type { GlmStreamChunk } from "../llm/glm-client.js";
import type { VisionMcpClient } from "../tools/vision-mcp-client.js";

function connection() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    signal: new AbortController().signal,
    async sessionUpdate(params: Record<string, unknown>) {
      updates.push(params);
    },
    async requestPermission() {
      return { outcome: { outcome: "selected", optionId: "allow" } };
    },
  };
}

function textGlm(onCall: (messages: unknown[]) => void = () => {}) {
  return {
    async *streamChat(messages: unknown[]): AsyncGenerator<GlmStreamChunk> {
      onCall(messages);
      yield { text: "done" };
      yield { done: true, stopReason: "stop" };
    },
  };
}

function imagePrompt() {
  return [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }];
}

test("cancelled delayed vision preprocessing settles without starting the model", async () => {
  const conn = connection();
  let visionStarted!: () => void;
  const started = new Promise<void>((resolve) => { visionStarted = resolve; });
  let releaseVision!: () => void;
  const visionDone = new Promise<void>((resolve) => { releaseVision = resolve; });
  let sourcePath = "";
  const vision: VisionMcpClient = {
    async callTool(_name, args) {
      sourcePath = String(args["image_source"]);
      visionStarted();
      await visionDone;
      return { content: [{ type: "text", text: "late" }] };
    },
    async dispose() {},
  };
  let modelCalls = 0;
  const agent = new GlmAcpAgent(conn as never, {
    visionClient: vision,
    sessionStore: null,
    glm: textGlm(() => { modelCalls += 1; }),
  });
  const { sessionId } = await agent.newSession({ cwd: tmpdir(), mcpServers: [] });
  const prompt = agent.prompt({ sessionId, prompt: imagePrompt(), messageId: "cancelled-1" });
  await started;
  assert.equal(existsSync(sourcePath), true);
  await agent.cancel({ sessionId });
  const result = await prompt;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.userMessageId, "cancelled-1");
  assert.equal(modelCalls, 0);
  releaseVision();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(sourcePath), false, "abort must remove materialized image data");
});

test("preprocessing abort before vision startup observes a rejecting late operation and makes no vision call", async () => {
  const controller = new AbortController();
  const root = await mkdtemp(join(tmpdir(), "glm-acp-abort-test-"));
  let writeStarted!: () => void;
  const writeReady = new Promise<void>((resolve) => { writeStarted = resolve; });
  let releaseWrite!: () => void;
  const writeDone = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let visionCalls = 0;
  const vision: VisionMcpClient = {
    async callTool() {
      visionCalls += 1;
      throw new Error("late vision failure");
    },
    async dispose() {},
  };
  const prepared = preprocessImageBlocks(imagePrompt(), vision, controller.signal, {
    async mkdtemp(prefix: string) {
      void prefix;
      return mkdtemp(join(root, "image-"));
    },
    async writeFile() {
      writeStarted();
      await writeDone;
      controller.abort();
    },
    rm,
  });
  await writeReady;
  releaseWrite();
  await assert.rejects(prepared, /cancelled|aborted/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visionCalls, 0, "abort during materialization must prevent vision startup");
  await rm(root, { recursive: true, force: true });
});

test("already-aborted preprocessing does not start a rejecting vision stub", async () => {
  const controller = new AbortController();
  controller.abort();
  let visionCalls = 0;
  const vision: VisionMcpClient = {
    async callTool() {
      visionCalls += 1;
      throw new Error("late vision failure");
    },
    async dispose() {},
  };
  await assert.rejects(
    preprocessImageBlocks([{ type: "image", data: "", mimeType: "image/png", uri: "https://example.test/image.png" }], vision, controller.signal),
    /cancelled|aborted/i,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visionCalls, 0, "an already-aborted prompt must not start vision");
});

test("abort between URI setup and queued vision startup prevents the call", async () => {
  const controller = new AbortController();
  let visionCalls = 0;
  const vision: VisionMcpClient = {
    async callTool() {
      visionCalls += 1;
      throw new Error("late vision failure");
    },
    async dispose() {},
  };
  const prepared = preprocessImageBlocks(
    [{ type: "image", data: "", mimeType: "image/png", uri: "https://example.test/image.png" }],
    vision,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(prepared, /cancelled|aborted/i);
  assert.equal(visionCalls, 0);
});

test("cancellation after vision starts still observes its late rejection", async () => {
  const controller = new AbortController();
  let rejectVision!: (error: Error) => void;
  const visionOperation = new Promise<unknown>((_resolve, reject) => { rejectVision = reject; });
  let visionCalls = 0;
  const vision: VisionMcpClient = {
    async callTool() {
      visionCalls += 1;
      controller.abort();
      return visionOperation;
    },
    async dispose() {},
  };
  await assert.rejects(
    preprocessImageBlocks([{ type: "image", data: "", mimeType: "image/png", uri: "https://example.test/image.png" }], vision, controller.signal),
    /cancelled|aborted/i,
  );
  assert.equal(visionCalls, 1);
  rejectVision(new Error("late vision failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("preprocessing write failures remove the directory created before the write", async () => {
  const created: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "glm-acp-prep-test-"));
  const result = await assert.rejects(
    preprocessImageBlocks(imagePrompt(), { callTool: async () => ({}), dispose: async () => {} }, undefined, {
      async mkdtemp(prefix: string) {
        void prefix;
        const dir = await mkdtemp(join(root, "image-"));
        created.push(dir);
        return dir;
      },
      async writeFile() {
        throw new Error("synthetic write failure");
      },
      rm,
    }),
  );
  assert.equal(result, undefined);
  assert.equal(created.length, 1);
  assert.equal(existsSync(created[0]!), false);
  await rm(root, { recursive: true, force: true });
});

test("close waits for preprocessing cleanup before persisting and removing the session", async () => {
  const conn = connection();
  const storeRoot = await mkdtemp(join(tmpdir(), "glm-acp-close-store-"));
  const sessionStore = new SessionStore(storeRoot);
  let started!: () => void;
  const prepStarted = new Promise<void>((resolve) => { started = resolve; });
  let releaseVision!: () => void;
  const visionDone = new Promise<void>((resolve) => { releaseVision = resolve; });
  let sourcePath = "";
  const vision: VisionMcpClient = {
    async callTool(_name, args) {
      sourcePath = String(args["image_source"]);
      started();
      await visionDone;
      return { content: [{ type: "text", text: "late" }] };
    },
    async dispose() {},
  };
  let saveSawCleanedImage = false;
  const save = sessionStore.save.bind(sessionStore);
  sessionStore.save = (session) => {
    saveSawCleanedImage = !existsSync(sourcePath);
    save(session);
  };
  const agent = new GlmAcpAgent(conn as never, {
    visionClient: vision,
    sessionStore,
    glm: textGlm(),
  });
  const { sessionId } = await agent.newSession({ cwd: tmpdir(), mcpServers: [] });
  const prompt = agent.prompt({ sessionId, prompt: imagePrompt() });
  await prepStarted;
  const closing = agent.closeSession({ sessionId });
  await prompt;
  await closing;
  releaseVision();
  assert.equal(saveSawCleanedImage, true, "close must persist only after lifecycle cleanup");
  assert.equal(existsSync(sourcePath), false);
  await assert.rejects(agent.prompt({ sessionId, prompt: [{ type: "text", text: "late" }] }), /Session not found/);
  await rm(storeRoot, { recursive: true, force: true });
});

test("a follow-up prompt starts after the cancelled image turn has fully unwound", async () => {
  const conn = connection();
  let releaseVision!: () => void;
  const visionDone = new Promise<void>((resolve) => { releaseVision = resolve; });
  let visionCall = 0;
  let modelCalls = 0;
  const vision: VisionMcpClient = {
    async callTool() {
      visionCall += 1;
      if (visionCall === 1) {
        await visionDone;
        return { content: [{ type: "text", text: "cancelled" }] };
      }
      return { content: [{ type: "text", text: "follow-up" }] };
    },
    async dispose() {},
  };
  const agent = new GlmAcpAgent(conn as never, {
    visionClient: vision,
    sessionStore: null,
    glm: textGlm(() => { modelCalls += 1; }),
  });
  const { sessionId } = await agent.newSession({ cwd: tmpdir(), mcpServers: [] });
  const cancelled = agent.prompt({ sessionId, prompt: imagePrompt(), messageId: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  await agent.cancel({ sessionId });
  releaseVision();
  assert.equal((await cancelled).stopReason, "cancelled");
  const followUp = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "next" }], messageId: "second" });
  assert.equal(followUp.stopReason, "end_turn");
  assert.equal(followUp.userMessageId, "second");
  assert.equal(modelCalls, 1);
});

test("queued prompts form a chain so only the newest prompt can reach the model", async () => {
  const conn = connection();
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const calls: string[] = [];
  const glm = {
    async *streamChat(messages: Array<{ role: string; content?: unknown }>, signal?: AbortSignal): AsyncGenerator<GlmStreamChunk> {
      const last = messages.at(-1)?.content;
      calls.push(typeof last === "string" ? last : "unknown");
      if (calls.length === 1) {
        firstStarted();
        await firstDone;
      }
      if (signal?.aborted) return;
      yield { text: "done" };
      yield { done: true, stopReason: "stop" };
    },
  };
  const agent = new GlmAcpAgent(conn as never, { glm, sessionStore: null });
  const { sessionId } = await agent.newSession({ cwd: tmpdir(), mcpServers: [] });
  const first = agent.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
  await firstStartedPromise;
  const second = agent.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] });
  const third = agent.prompt({ sessionId, prompt: [{ type: "text", text: "three" }] });
  releaseFirst();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map((r) => r.stopReason), ["cancelled", "cancelled", "end_turn"]);
  assert.deepEqual(calls, ["one", "three"]);
});
