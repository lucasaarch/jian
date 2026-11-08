import { Mail, Send, Smartphone, Terminal } from 'lucide-react';

/** The transports a profile can configure, and what each one asks of the owner. */
export const kinds = [
  {
    type: 'whatsapp' as const,
    name: 'WhatsApp (Baileys)',
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
    type: 'email' as const,
    name: 'Email',
    icon: Mail,
    description: 'An address on a domain you send and receive with through Resend or Cloudflare.',
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
