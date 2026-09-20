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
  readChatIdentity,
  readCommonPhrasePanelText,
  readEditorText,
  readHeaderText,
  readOutgoingMessageBodies,
  type ModalClassification,
  type RiskEvidence,
} from "./chat-reader";

export {
  createCommunicationAction,
  evaluateGuards,
  findActiveDetailRoot,
  findConversationRoot,
  isChatEditorEmpty,
  readCommonPhrases,
  type ActionOptions,
  type BlockedResult,
  type CommunicationAction,
  type CommunicationActionDeps,
  type DispatchResult,
  type ObserveResult,
  type PrepareResult,
} from "./communication-action";

export {
  COMMUNICATION_SELECTORS,
  COMMUNICATION_SELECTOR_KEYS,
  communicationSelectorEntries,
  isHeuristic,
  normalizeText,
  queryAll,
  queryFirst,
  type CommunicationSelectorKey,
} from "./selectors";

export { writeEditorText, type WriteResult } from "./write-editor";
