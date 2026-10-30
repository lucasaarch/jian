import { Appearance, Overlay, SettingsGroup, SettingsLayout, Toggle } from '@jian/ui';
import { AppWindow, Palette } from 'lucide-react';
import { useEffect, useState } from 'react';
import { desktop } from '../desktop';

type Page = 'appearance' | 'app';

/** The app's settings, from ⌘, or the status bar's gear. */
export function AppSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = useState<Page>('appearance');
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Settings">
      <SettingsLayout
        heading="Settings"
        pages={[
          { id: 'appearance', label: 'Appearance', icon: <Palette size={16} />, group: 'App' },
          { id: 'app', label: 'Startup', icon: <AppWindow size={16} />, group: 'App' },
        ]}
        current={page}
        onSelect={(id) => setPage(id as Page)}
      >
        {page === 'appearance' ? <Appearance /> : <Startup />}
      </SettingsLayout>
    </Overlay>
  );
}

function Startup() {
  const [openAtLogin, setOpenAtLogin] = useState(false);
  useEffect(() => {
    void desktop().openAtLogin().then(setOpenAtLogin);
  }, []);
  return (
    <>
      <SettingsGroup title="Startup">
        <Toggle
          label="Open Jian at login"
          detail="It starts in the tray, so replies reach you and this computer's gateway is ready."
          checked={openAtLogin}
          onCheckedChange={(checked) => {
            setOpenAtLogin(checked);
            void desktop().setOpenAtLogin(checked);
          }}
        />
      </SettingsGroup>
      <p className="text-xs text-muted">Jian {desktop().version}</p>
    </>
  );
}
