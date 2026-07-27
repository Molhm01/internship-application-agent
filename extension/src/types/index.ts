/**
 * Extension-local types. Anything shared with the agent server belongs in
 * `shared/` instead, so the two sides can never drift apart.
 */
export type {
  AgentStatusResult,
  ContentPingResult,
  ExtensionMessage,
} from '../messaging/messages.js';
export type { ExtensionSettings } from '../storage/settings.js';
