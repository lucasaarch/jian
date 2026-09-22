import { Send, Smartphone, Terminal } from 'lucide-react';

/** The three transports a profile can connect, and what each one asks of the owner. */
export const kinds = [
  {
    type: 'whatsapp' as const,
    name: 'WhatsApp',
    icon: Smartphone,
    description: 'A device paired to your WhatsApp. Connecting means scanning the QR code.',
  },
  {
    type: 'telegram' as const,
    name: 'Telegram',
    icon: Send,
    description: 'A bot from BotFather. Connecting means giving it its token.',
  },
  {
    type: 'api' as const,
    name: 'API Server',
    icon: Terminal,
    description: 'An HTTP endpoint for your own systems to send messages through.',
  },
];

export const states = {
  disconnected: 'Device disconnected',
  connecting: 'Connecting',
  qr: 'Waiting for the QR code to be scanned',
  connected: 'Device connected',
  error: 'Connection failed',
};
