/**
 * App Service facade over the shared Redis control channel transport.
 *
 * The transport implementation lives in `../interactiveControlBus.ts` (zero
 * database imports) so `interactiveActorHost/` never imports from `chatHarness/`.
 */
export {
  chatHarnessControlBus,
  controlAckChannelFor,
  controlChannelFor,
  createChatHarnessControlBus,
  initChatHarnessControlBus,
  shutdownChatHarnessControlBus,
  type ChatHarnessControlBus,
  type ChatHarnessControlBusOptions,
  type ControlAckCallback,
  type ControlMessageCallback,
  type HarnessCancelDisposition,
  type HarnessControlAck,
  type HarnessControlDisposition,
  type HarnessSteerDisposition,
} from '../interactiveControlBus';
