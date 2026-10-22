// A component of Speck's default path: one piece of cognition that may act
// on a turn. The default path (respond.ts) is the model's ordinary chat; a
// component adds to it only where it has something to add, through three
// optional steps:
//
// - observe:    read the user's message and update the component's own state
//               (kept in the session, so it persists);
// - contribute: a section of notes the answering model is shown with the
//               conversation, or null to leave the turn untouched;
// - review:     after the model answers, a replacement reply with its reason,
//               or null to let the reply stand.
//
// A turn no component contributes to or reviews is sent to the model exactly
// as the model would receive it on its own, so the plain model is the floor.
// Components return to the path one at a time, each admitted only by a
// no-harm measurement against the path without it (docs/REINTEGRATION.md).

import type { ModelRegistry } from "../models/registry.js";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { ChatMessage, ChatSettings } from "./chat.js";
import type { Session } from "./session.js";

export interface TurnContext {
  session: Session;
  message: string;
  // Index of this user message in the session, from 0.
  turn: number;
  // The conversation before this message, as the model sees it.
  history: readonly ChatMessage[];
  registry: ModelRegistry;
  // The runtime, for components that keep memory or use tools.
  runtime?: SpeckRuntime | undefined;
  readerProcessorId: string;
  chat: ChatSettings;
  fetch?: typeof fetch | undefined;
  // What a component's earlier steps found on this turn, for its later steps.
  scratch: Map<string, unknown>;
}

export interface Review {
  reply: string;
  reason: string;
}

export interface Component {
  // Short and stable: it names the turn's path ("rule-notes") and the
  // component's state in the session.
  id: string;
  observe?(context: TurnContext): Promise<void>;
  contribute?(context: TurnContext): Promise<string | null>;
  review?(context: TurnContext, reply: string): Promise<Review | null>;
  // What the component did on this turn, for the session log.
  record?(context: TurnContext): Record<string, unknown>;
  // A component that adds time or a feature without improving answers has a
  // switch on the System → Cognition page; one that improves answers has
  // none and is always on.
  option?: ComponentOption;
}

export interface ComponentOption {
  label: string;
  // What it adds, in the user's terms.
  description: string;
  // Its measured cost per message.
  cost: string;
  enabledByDefault: boolean;
}

// The component's own state in the session, created on first use.
export function componentState<T>(session: Session, id: string, initial: () => T): T {
  session.state ??= {};
  if (!(id in session.state)) session.state[id] = initial();
  return session.state[id] as T;
}

export const NOTES_HEADING = "NOTES ON THIS CONVERSATION (kept outside the model)";
