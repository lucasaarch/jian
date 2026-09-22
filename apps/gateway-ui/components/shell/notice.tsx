'use client';
import { CircleCheck, CircleX, Info } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Toaster, toast } from 'sonner';
import { useWorkspace } from '../../lib/workspace';

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

export function NoticeBar() {
  const { notice } = useWorkspace();
  const announced = useRef<typeof notice>(undefined);
  useEffect(() => {
    if (!notice || announced.current === notice) return;
    announced.current = notice;
    if (notice.error) toast.error(notice.text, { duration: 8000 });
    else toast.success(notice.text);
  }, [notice]);
  return null;
}
