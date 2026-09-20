/**
 * BOSS Zhipin communication adapter — public surface.
 *
 * ============================ HONESTY NOTICE ============================
 * Nothing in this directory is verified against the real BOSS Zhipin site. The
 * real chat DOM, send button, success dialog and failure markers were never
 * inspected. Everything here is validated exclusively against the synthetic
 * fixtures under `tests/fixtures/boss/`, which were authored to match these
 * files. Passing tests prove the plumbing; they prove nothing about the live
 * site.
 * =======================================================================
 *
 * Exposed so the queue runner can import one path:
 *   - `createCommunicationAction` — the action surface (find / read / prepare /
 *     dispatch / observe), with the never-send-twice guard inside `dispatchSend`.
 *   - the pure readers, for diagnostics and unit tests.
 *   - `COMMUNICATION_SELECTORS` + `communicationSelectorEntries()`, so a
 *     diagnostics UI can list exactly which selectors are `fixture-only` versus
 *     `unverified`.
 */

export {
  classifyModal,
  detectRiskBanner,
  extractJobIds,
  findChatRoot,
  findEditor,
  findSendButton,
  isContentEditable,
  isEditorEmpty,
  isFailedOutgoing,
  type ModalClassification,
  type RiskEvidence,
  readChatIdentity,
  readCommonPhrasePanelText,
  readEditorText,
  readHeaderText,
  readOutgoingMessageBodies,
} from "./chat-reader";
export {
  type ActionOptions,
  type BlockedResult,
  type CommunicationAction,
  type CommunicationActionDeps,
  createCommunicationAction,
  type DispatchResult,
  evaluateGuards,
  findActiveDetailRoot,
  findConversationRoot,
  isChatEditorEmpty,
  type ObserveResult,
  type PrepareResult,
  readCommonPhrases,
} from "./communication-action";
export { isPlausibleJobId } from "./job-id";

export {
  COMMUNICATION_SELECTOR_KEYS,
  COMMUNICATION_SELECTORS,
  type CommunicationSelectorKey,
  communicationSelectorEntries,
  isHeuristic,
  normalizeText,
  queryAll,
  queryFirst,
} from "./selectors";

export { type WriteResult, writeEditorText } from "./write-editor";
