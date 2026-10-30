import { MessagesSquare, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { TelegramLogo, WhatsAppLogo } from '../ui';
import type { Provider } from './conversations';

/** Each provider's mark, beside a conversation a schedule can run in. */
export const marks: Record<Provider, ReactNode> = {
  chats: <MessagesSquare size={16} aria-hidden="true" />,
  whatsapp: <WhatsAppLogo size={16} />,
  telegram: <TelegramLogo size={16} />,
  api: <Terminal size={16} aria-hidden="true" />,
};

/** The first choice of all: no conversation of its own, a new chat each time it runs. */
export const NEW_CHAT = {
  name: 'A new chat each time',
  where: 'Opens a chat in Chats when it runs',
};
