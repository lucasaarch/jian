/**
 * The channels a person writes in from their own app: an approval or a question there is asked
 * in the chat itself, and only there. The API channel and the panel's own conversations are
 * answered from the panel.
 */
const CHAT_CHANNELS = new Set(['whatsapp', 'whatsapp-business', 'telegram']);

export function isChatChannel(channel: string): boolean {
  return CHAT_CHANNELS.has(channel);
}
