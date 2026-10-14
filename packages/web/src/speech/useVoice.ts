/**
 * The chat's voice: what the assistant says and plays while a turn runs and when it answers, the
 * microphone, and the hands-free conversation that joins the two.
 *
 * With speech on, a turn starts with a tone (and, for a spoken request, a short acknowledgement),
 * names the kinds of work it reaches when it runs longer (turnNarrator.ts), calls the user with a
 * tone and a line when it waits on them, and ends with a tone and its answer read aloud — in full
 * when it is short, as a summary when it is long, with the full text a click away. Stop silences
 * all of it, and an answer is read only when it is this turn's.
 *
 * In a conversation the microphone stays open: what the user says is sent once they pause, the
 * microphone rests while the turn runs, and speaking over the answer interrupts it.
 */

import { useStorage } from "@vueuse/core";
import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { useGatewayStore, type ChatMessage } from "@/stores/gateway";
import { useMultimodalStore } from "@/stores/multimodal";
import { playEarcon, unlockAudio, webAudioSink, type Earcon } from "./audioOutput";
import { browserVoice } from "./browserVoice";
import { PhraseBook, phrasesFor, spokenPhraseLanguage, type PhraseKind } from "./speechPhrases";
import { SpeechPlayer, type SpeechActivity, type SpeechPriority } from "./speechPlayer";
import { detectLanguage, isShortForSpeech, languageCode, leadSentences, toSpeakableText } from "./speechText";
import { TurnNarrator } from "./turnNarrator";
import { lastAssistantMessage, turnOutcome } from "./turnOutcome";
import { VoiceCapture, type Utterance } from "./voiceCapture";

/** What a running turn makes heard: spoken lines and tones, tones only, or nothing until its answer. */
export type SpeechUpdates = "voice" | "tones" | "off";
/** The language speech is transcribed in; "auto" lets the speech service tell. */
export type SttLanguage = "auto" | "de" | "en" | "pl";
export type VoicePhase = "off" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";

export interface SpokenReply {
  messageId: string;
  /** The whole answer as it is spoken. */
  fullText: string;
  /** What was said: the answer, or its summary. */
  spokenText: string;
  summarized: boolean;
  language: string;
}

export type RecordingOutcome =
  | { kind: "transcribed"; text: string; language?: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

interface TurnRecord {
  sessionId: string | null;
  narrator: TurnNarrator;
  /** The newest assistant message before the turn: its answer is one after it. */
  previousAssistantId: string | null;
  language: string;
}

/** The speech service unloads an idle voice after five minutes; it is used again before that. */
const WARM_EVERY_MS = 4 * 60_000;
/** A summary that takes longer than this is not waited for: the answer's opening is read instead. */
const SUMMARY_TIMEOUT_MS = 12_000;
/** The pause that ends what the user says in a conversation. */
const CONVERSATION_END_SILENCE_MS = 1_200;
const MAX_SUMMARIES = 16;

export interface UseVoiceOptions {
  ttsAvailable: Ref<boolean>;
  /** Sends what the user said in a conversation. */
  submit(text: string): Promise<void>;
  /** Puts a transcript in the composer (the mic button, a wake word, an audio file). */
  appendToComposer(text: string): void;
  /** The silence that ends a recording from the mic button. */
  recordSilenceMs: Ref<number>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useVoice(options: UseVoiceOptions) {
  const gateway = useGatewayStore();
  const multimodal = useMultimodalStore();

  const speakEnabled = useStorage<boolean>("sai_speak_reply", false);
  const speechUpdates = useStorage<SpeechUpdates>("sai_speech_updates", "voice");
  const sttLanguage = useStorage<SttLanguage>("sai_stt_language", "auto");
  const conversation = ref(false);
  const phase = ref<VoicePhase>("off");
  const activity = shallowRef<SpeechActivity | null>(null);
  const preparingReply = ref(false);
  const lastReply = ref<SpokenReply | null>(null);
  const micLevel = ref(0);
  const recording = ref<"idle" | "recording" | "processing">("idle");
  const notice = ref("");

  const phrases = new PhraseBook();
  const player = new SpeechPlayer({
    synthesize: (text, language, signal) => gateway.synthesizeSpeech({ text, language }, { signal }),
    sink: webAudioSink,
    fallback: browserVoice,
    serviceAvailable: () => options.ttsAvailable.value,
  });
  const unsubscribe = player.onChange((next) => { activity.value = next; });

  // ── Language ────────────────────────────────────────────────────────────
  const lastLanguage = ref<string | null>(null);
  const defaultLanguage = () => languageCode(multimodal.config.tts.defaultLanguage) ?? "en";
  const preferredLanguage = () => lastLanguage.value ?? defaultLanguage();
  /** A transcript went to the composer: the request it is sent in was spoken, in this language. */
  let pendingVoiceLanguage: string | null = null;

  const audible = () => speakEnabled.value || conversation.value;

  function tone(kind: Earcon): void {
    if (audible() && speechUpdates.value !== "off") playEarcon(kind);
  }

  function say(kind: PhraseKind, language: string, priority: SpeechPriority = "progress"): void {
    const phrase = phrases.pick(kind, language);
    void player.speak({ text: phrase.text, language: phrase.language, priority, label: phrase.text });
  }

  // ── The answer ──────────────────────────────────────────────────────────
  let replyAbort: AbortController | null = null;
  const summaries = new Map<string, string>();

  async function summaryOf(message: ChatMessage, signal: AbortSignal): Promise<string> {
    const cached = summaries.get(message.id);
    if (cached) return cached;
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), SUMMARY_TIMEOUT_MS);
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const maxSentences = multimodal.config.tts.speakReplySummaryMaxSentences ?? 3;
      const summary = toSpeakableText(await gateway.summarizeForSpeech({ text: message.content, maxSentences }, { signal: abort.signal }));
      if (!summary) throw new Error("The summary was empty");
      summaries.set(message.id, summary);
      while (summaries.size > MAX_SUMMARIES) summaries.delete(summaries.keys().next().value!);
      return summary;
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Reads an answer aloud: a short one in full, a long one as a summary unless `full`. */
  async function speakReply(message: ChatMessage, opts: { full?: boolean; fallbackLanguage?: string } = {}): Promise<void> {
    const fullText = toSpeakableText(message.content);
    if (!fullText) return;
    const language = detectLanguage(fullText) ?? opts.fallbackLanguage ?? preferredLanguage();
    replyAbort?.abort();
    const abort = new AbortController();
    replyAbort = abort;
    let spokenText = fullText;
    let summarized = false;
    if (!opts.full && !isShortForSpeech(fullText)) {
      summarized = true;
      preparingReply.value = true;
      try {
        spokenText = await summaryOf(message, abort.signal);
      } catch {
        // Stopped, or replaced by another answer: nothing to say. Otherwise the summary failed or
        // took too long, and the answer's opening stands in for it.
        if (abort.signal.aborted) return;
        spokenText = `${leadSentences(fullText)} ${phrases.pick("fullAnswerInChat", language).text}`;
      } finally {
        if (replyAbort === abort) preparingReply.value = false;
      }
    }
    if (replyAbort !== abort || abort.signal.aborted) return;
    lastLanguage.value = language;
    lastReply.value = { messageId: message.id, fullText, spokenText, summarized, language };
    const outcome = await player.speak({ text: spokenText, language, priority: "reply", label: summarized ? "summary" : "answer" });
    if (outcome === "failed") notice.value = "The answer could not be spoken — the speech service and the browser's voice both failed.";
  }

  /** Silences everything: the answer, a summary being made for it, and any line under way. */
  function stopSpeaking(): void {
    replyAbort?.abort();
    replyAbort = null;
    preparingReply.value = false;
    player.stop();
  }

  function latestAnswer(): ChatMessage | undefined {
    for (let index = gateway.messages.length - 1; index >= 0; index -= 1) {
      const message = gateway.messages[index];
      if (message?.role === "assistant" && message.id !== "streaming" && !message.blocked && message.content.trim()) return message;
    }
    return undefined;
  }

  async function speakLatest(): Promise<void> {
    unlockAudio();
    const message = latestAnswer();
    if (message) await speakReply(message);
  }

  async function readFullReply(): Promise<void> {
    unlockAudio();
    const reply = lastReply.value;
    if (!reply) return;
    replyAbort?.abort();
    replyAbort = null;
    lastReply.value = { ...reply, spokenText: reply.fullText, summarized: false };
    await player.speak({ text: reply.fullText, language: reply.language, priority: "reply", label: "answer" });
  }

  async function replay(): Promise<void> {
    unlockAudio();
    const reply = lastReply.value;
    if (!reply) return;
    await player.speak({ text: reply.spokenText, language: reply.language, priority: "reply", label: reply.summarized ? "summary" : "answer" });
  }

  function dismissReply(): void {
    if (activity.value?.priority === "reply" || preparingReply.value) return;
    lastReply.value = null;
  }

  function toggleSpeak(): void {
    unlockAudio();
    speakEnabled.value = !speakEnabled.value;
    if (speakEnabled.value) return;
    stopSpeaking();
    if (conversation.value) stopConversation();
  }

  // ── The running turn ────────────────────────────────────────────────────
  let turn: TurnRecord | null = null;
  let narratorTimer: number | null = null;

  function lastUserText(): string {
    for (let index = gateway.messages.length - 1; index >= 0; index -= 1) {
      const message = gateway.messages[index];
      if (message?.role === "user") return message.content;
    }
    return "";
  }

  function waitingFor(): { key: string; approval: boolean } | null {
    if (gateway.pendingApproval) return { key: `approval:${gateway.pendingApproval.approvalId}`, approval: true };
    if (gateway.pendingInputRequest) return { key: `ask:${gateway.pendingInputRequest.inputId}`, approval: false };
    const card = gateway.sessionUserInputs[0];
    if (card) return { key: `card:${card.inputId}`, approval: false };
    if (gateway.pendingIntervention) return { key: `intervention:${gateway.pendingIntervention.reasonCode}`, approval: false };
    return null;
  }

  function stopNarrator(): void {
    if (narratorTimer !== null) window.clearInterval(narratorTimer);
    narratorTimer = null;
  }

  function tickNarrator(): void {
    if (!turn || !audible() || speechUpdates.value === "off") return;
    const streaming = gateway.messages.find((message) => message.id === "streaming");
    const cue = turn.narrator.observe({ now: Date.now(), steps: streaming?.steps ?? [], waitingFor: waitingFor() });
    if (!cue) return;
    if (cue.kind === "needsInput") tone("attention");
    if (speechUpdates.value !== "voice") return;
    if (cue.kind === "milestone") say(cue.milestone, turn.language);
    else if (cue.kind === "stillWorking") say(cue.long ? "stillWorkingLong" : "stillWorking", turn.language);
    else say(cue.approval ? "approval" : "needsInput", turn.language);
  }

  function onTurnStart(): void {
    const voiceLanguage = pendingVoiceLanguage;
    pendingVoiceLanguage = null;
    // The language the chat shows this turn in (stores/gateway.ts notes it on the live bubble), so
    // what is said and what is shown agree; a spoken request's own language wins.
    const shown = gateway.messages.find((message) => message.id === "streaming")?.language;
    const language = voiceLanguage ?? shown ?? detectLanguage(lastUserText()) ?? preferredLanguage();
    turn = {
      sessionId: gateway.currentSessionId,
      narrator: new TurnNarrator(Date.now()),
      previousAssistantId: lastAssistantMessage(gateway.messages)?.id ?? null,
      language,
    };
    // A new request: whatever was still being said belongs to the last one.
    stopSpeaking();
    if (!audible()) return;
    tone("start");
    if (voiceLanguage && speechUpdates.value === "voice") say("ack", language, "ack");
    stopNarrator();
    narratorTimer = window.setInterval(tickNarrator, 1_000);
  }

  async function onTurnEnd(): Promise<void> {
    stopNarrator();
    const ended = turn;
    turn = null;
    player.stop("progress");
    player.stop("ack");
    if (!ended || ended.sessionId !== gateway.currentSessionId || !audible()) return;
    const outcome = turnOutcome(gateway.messages, ended.previousAssistantId);
    if (outcome.kind === "silent") return;
    if (outcome.kind === "failed") {
      tone("error");
      if (speechUpdates.value === "voice") say("failed", ended.language);
      return;
    }
    tone("done");
    await speakReply(outcome.message, { fallbackLanguage: ended.language });
  }

  watch(() => gateway.isLoading, (loading, was) => {
    if (loading && !was) onTurnStart();
    else if (!loading && was) void onTurnEnd();
  });

  watch(() => gateway.currentSessionId, () => {
    stopNarrator();
    turn = null;
    stopSpeaking();
    lastReply.value = null;
  });

  // ── Transcription ───────────────────────────────────────────────────────
  async function transcribe(audio: Blob, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
    const hint = sttLanguage.value === "auto" ? undefined : sttLanguage.value;
    const result = await gateway.transcribeAudio(audio, { ...(hint ? { language: hint } : {}), ...(signal ? { signal } : {}) });
    const text = result.text?.trim() ?? "";
    const language = languageCode(result.language) ?? hint ?? detectLanguage(text);
    if (language) lastLanguage.value = language;
    return { text, ...(language ? { language } : {}) };
  }

  /** Transcribes an audio file into the composer. */
  async function transcribeFile(file: File): Promise<RecordingOutcome> {
    try {
      const result = await transcribe(file);
      if (!result.text) return { kind: "empty" };
      options.appendToComposer(result.text);
      pendingVoiceLanguage = result.language ?? null;
      return { kind: "transcribed", ...result };
    } catch (error) {
      return { kind: "error", message: errorText(error) };
    }
  }

  // ── The mic button ──────────────────────────────────────────────────────
  let manualCapture: VoiceCapture | null = null;
  let manualDone: ((outcome: RecordingOutcome) => void) | null = null;

  async function finishManual(utterance: Utterance | null): Promise<void> {
    manualCapture?.close();
    manualCapture = null;
    micLevel.value = 0;
    const done = manualDone;
    manualDone = null;
    if (!utterance) {
      recording.value = "idle";
      done?.({ kind: "empty" });
      return;
    }
    recording.value = "processing";
    try {
      const result = await transcribe(utterance.audio);
      if (!result.text) {
        done?.({ kind: "empty" });
        return;
      }
      options.appendToComposer(result.text);
      pendingVoiceLanguage = result.language ?? null;
      done?.({ kind: "transcribed", ...result });
    } catch (error) {
      done?.({ kind: "error", message: errorText(error) });
    } finally {
      recording.value = "idle";
    }
  }

  /** Records until the user pauses, then transcribes into the composer; resolves with how it went. */
  async function startRecording(): Promise<RecordingOutcome> {
    if (recording.value !== "idle" || conversation.value) return { kind: "error", message: "The microphone is in use" };
    unlockAudio();
    stopSpeaking();
    const capture = new VoiceCapture(
      { onUtterance: (utterance) => { void finishManual(utterance); }, onLevel: (level) => { micLevel.value = level; } },
      { endSilenceMs: options.recordSilenceMs.value, noSpeechTimeoutMs: 10_000 },
    );
    try {
      await capture.open();
    } catch (error) {
      return { kind: "error", message: errorText(error) };
    }
    manualCapture = capture;
    recording.value = "recording";
    const outcome = new Promise<RecordingOutcome>((resolve) => { manualDone = resolve; });
    capture.record();
    tone("listen");
    return outcome;
  }

  /** Ends the mic-button recording now. */
  function finishRecording(): void {
    manualCapture?.finish();
  }

  // ── Conversation ────────────────────────────────────────────────────────
  let conversationCapture: VoiceCapture | null = null;
  let transcribeAbort: AbortController | null = null;

  /** Puts the open microphone in the state the conversation is in. */
  function syncConversation(): void {
    const capture = conversationCapture;
    if (!conversation.value || !capture || phase.value === "transcribing") return;
    if (gateway.isLoading) {
      capture.pause();
      phase.value = "thinking";
      return;
    }
    const speaking = activity.value?.priority === "reply" || preparingReply.value;
    capture.setBargeIn(speaking);
    capture.listen();
    if (phase.value !== "hearing") phase.value = speaking ? "speaking" : "listening";
  }

  async function onConversationUtterance(utterance: Utterance | null): Promise<void> {
    const capture = conversationCapture;
    if (!capture) return;
    if (!utterance) {
      phase.value = "listening";
      syncConversation();
      return;
    }
    capture.pause();
    phase.value = "transcribing";
    tone("heard");
    const abort = new AbortController();
    transcribeAbort = abort;
    try {
      const result = await transcribe(utterance.audio, abort.signal);
      if (!result.text || !conversation.value) return;
      pendingVoiceLanguage = result.language ?? preferredLanguage();
      phase.value = "thinking";
      await options.submit(result.text);
    } catch (error) {
      if (abort.signal.aborted) return;
      notice.value = errorText(error);
      tone("error");
    } finally {
      if (transcribeAbort === abort) transcribeAbort = null;
      if (phase.value === "transcribing" || phase.value === "thinking") phase.value = "listening";
      syncConversation();
    }
  }

  async function startConversation(): Promise<void> {
    unlockAudio();
    const capture = new VoiceCapture({
      onSpeechStart: () => {
        // Speaking over the answer interrupts it.
        if (activity.value || preparingReply.value) stopSpeaking();
        phase.value = "hearing";
      },
      onUtterance: (utterance) => { void onConversationUtterance(utterance); },
      onLevel: (level) => { micLevel.value = level; },
    }, { endSilenceMs: CONVERSATION_END_SILENCE_MS });
    try {
      await capture.open();
    } catch (error) {
      notice.value = errorText(error);
      return;
    }
    conversationCapture = capture;
    conversation.value = true;
    speakEnabled.value = true;
    notice.value = "";
    phase.value = "listening";
    playEarcon("listen");
    syncConversation();
  }

  function stopConversation(): void {
    conversation.value = false;
    transcribeAbort?.abort();
    transcribeAbort = null;
    conversationCapture?.close();
    conversationCapture = null;
    micLevel.value = 0;
    phase.value = "off";
    stopSpeaking();
  }

  async function toggleConversation(): Promise<void> {
    if (conversation.value) stopConversation();
    else await startConversation();
  }

  watch([() => gateway.isLoading, activity, preparingReply], () => syncConversation());

  // ── Keeping the voice loaded ────────────────────────────────────────────
  let warmTimer: number | null = null;
  let lastWarmAt = 0;
  const prefetched = new Set<string>();

  async function prefetchPhrases(language: string): Promise<void> {
    const lang = spokenPhraseLanguage(language);
    if (prefetched.has(lang)) return;
    prefetched.add(lang);
    for (const kind of ["ack", "needsInput", "stillWorking"] as const) {
      for (const text of phrasesFor(kind, lang)) await player.prefetch(text, lang);
    }
  }

  async function warm(): Promise<void> {
    if (!options.ttsAvailable.value || !audible() || document.visibilityState !== "visible") return;
    lastWarmAt = Date.now();
    const languages = [...new Set([defaultLanguage(), lastLanguage.value].filter((code): code is string => Boolean(code)))];
    for (const language of languages) {
      await gateway.warmSpeech(language).catch(() => undefined);
      void prefetchPhrases(language);
    }
  }

  watch([speakEnabled, conversation, options.ttsAvailable], () => {
    const on = audible() && options.ttsAvailable.value;
    if (on && warmTimer === null) {
      void warm();
      warmTimer = window.setInterval(() => { void warm(); }, WARM_EVERY_MS);
    } else if (!on && warmTimer !== null) {
      window.clearInterval(warmTimer);
      warmTimer = null;
    }
  }, { immediate: true });

  const onVisibility = () => {
    if (document.visibilityState === "visible" && warmTimer !== null && Date.now() - lastWarmAt >= WARM_EVERY_MS) void warm();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // After a reload with speech on, the page may not make sound until the user interacts with it:
  // the first click or key (sending a message is one) lets it.
  const unlockOnGesture = () => {
    if (!audible()) return;
    unlockAudio();
    document.removeEventListener("pointerdown", unlockOnGesture, true);
    document.removeEventListener("keydown", unlockOnGesture, true);
  };
  document.addEventListener("pointerdown", unlockOnGesture, true);
  document.addEventListener("keydown", unlockOnGesture, true);

  // Another voice speaks now: what was synthesised with the old one is not reused.
  watch(
    () => JSON.stringify([multimodal.config.tts.api, multimodal.config.tts.voices, multimodal.config.tts.defaultVoiceId, multimodal.config.tts.defaultSpeaker]),
    () => {
      player.clearCache();
      prefetched.clear();
    },
  );

  onBeforeUnmount(() => {
    unsubscribe();
    stopNarrator();
    stopConversation();
    manualCapture?.close();
    manualCapture = null;
    if (warmTimer !== null) window.clearInterval(warmTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointerdown", unlockOnGesture, true);
    document.removeEventListener("keydown", unlockOnGesture, true);
  });

  return {
    speakEnabled,
    speechUpdates,
    sttLanguage,
    conversation,
    phase,
    activity,
    preparingReply,
    lastReply,
    micLevel,
    recording,
    notice,
    toggleSpeak,
    toggleConversation,
    startRecording,
    finishRecording,
    transcribeFile,
    speakLatest,
    readFullReply,
    replay,
    stopSpeaking,
    dismissReply,
  };
}
