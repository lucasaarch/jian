'use client';
import { CircleCheck, CircleX, Info } from 'lucide-react';
import { Toaster } from 'sonner';
import { useThemeChoice } from './theme';

export function Notifications() {
  // Sonner draws in its own light or dark; it follows the panel's.
  const { theme } = useThemeChoice();
  return (
    <Toaster
      theme={theme}
      position="top-right"
      containerAriaLabel="Notifications"
      gap={10}
      closeButton
      icons={{
        success: <CircleCheck size={18} />,
        error: <CircleX size={18} />,
        info: <Info size={18} />,
      }}
      toastOptions={{
        className: 'jian-toast',
        duration: 5000,
        closeButtonAriaLabel: 'Dismiss notification',
      }}
    />
  );
}
