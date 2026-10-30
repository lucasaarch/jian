'use client';
import { CircleCheck, CircleX, Info } from 'lucide-react';
import { Toaster } from 'sonner';

export function Notifications() {
  return (
    <Toaster
      position="top-right"
      containerAriaLabel="Notifications"
      gap={10}
      closeButton
      icons={{
        success: <CircleCheck size={20} />,
        error: <CircleX size={20} />,
        info: <Info size={20} />,
      }}
      toastOptions={{
        className: 'jian-toast',
        duration: 5000,
        closeButtonAriaLabel: 'Dismiss notification',
      }}
    />
  );
}
