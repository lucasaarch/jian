'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { Mark } from '../../components/ui/mark';
import { Action } from '../../kit';
import { AgentHero } from '../../kit/agent-hero';
import type { Profile } from '../../lib/api';
import { useAppearance } from '../../lib/appearance';
import { useCreateProfile } from '../../lib/create-profile';
import { queries } from '../../lib/query/profile';
import { ProviderConnections } from '../settings/providers-page';
import { WelcomeChannels } from './channels';
import { ExistingAgent } from './existing-agent';
import { type IdentityDraft, WelcomeIdentity } from './identity';
import { WelcomeIntro } from './intro';

const settle = [0.23, 1, 0.32, 1] as const;
type Step = 'intro' | 'models' | 'identity' | 'channels' | 'arrival';
const titles: Record<Step, string> = {
  intro: 'A little intelligence. A world of possibility.',
  models: 'Give it a mind.',
  identity: 'Make it yours.',
  channels: 'Take the conversation with you.',
  arrival: 'This is the beginning.',
};

/** Server facts decide what is left to do. Only the unsaved form and the current scene are local. */
export function Welcome({
  saved,
  onCreated,
  finish,
}: {
  saved?: Profile;
  onCreated: (profile: Profile) => void;
  finish: (profile: Profile) => void;
}) {
  // A persisted empty cache is not evidence that the gateway is still empty.
  const profiles = useQuery({ ...queries.profiles(), refetchOnMount: 'always' });
  const providers = useQuery({ ...queries.providers(), refetchOnMount: 'always' });
  const gateway = useQuery(queries.gateway());
  const connected = providers.data?.some((provider) => !provider.revokedAt) ?? false;
  const server = gateway.data?.mode !== 'local';
  const [newAgent, setNewAgent] = useState(false);
  const [modelsVisited, setModelsVisited] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [draft, setDraft] = useState<IdentityDraft>({
    name: '',
    summary: '',
    instructions: '',
    avatar: null,
  });
  const { still } = useAppearance();
  const { create, busy, error } = useCreateProfile((profile) => {
    onCreated(profile);
    setStep(server ? 'channels' : 'arrival');
  });
  const steps: Step[] = [
    'intro',
    ...(connected && !modelsVisited ? [] : ['models' as const]),
    'identity',
    ...(server ? ['channels' as const] : []),
    'arrival',
  ];
  const current = steps.indexOf(step);
  const failure = !saved && (profiles.isError || providers.isError || gateway.isError);
  const ready =
    saved || (profiles.isFetchedAfterMount && providers.isFetchedAfterMount && gateway.data);

  return (
    <main
      aria-label="Welcome to Jian"
      className="relative isolate flex h-(--app-height) min-h-0 flex-col overflow-hidden bg-canvas text-ink pt-[max(2.5rem,var(--chrome-top,0px))]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-64 left-1/2 h-[42rem] w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,var(--glass-press),transparent_65%)]" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className="mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-4 px-6 py-6 md:px-12">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="size-5 [&_svg]:size-full">
              <Mark />
            </span>{' '}
            Jian
          </span>
          <span className="text-[11px] tracking-[0.15em] text-muted uppercase">
            A space of your own
          </span>
        </header>
        {!ready || failure ? (
          <div
            className="grid flex-1 place-content-center gap-4 px-6 text-center"
            role={failure ? 'alert' : 'status'}
          >
            <p className="text-sm text-muted">
              {failure
                ? 'Your gateway could not be read. Your progress is safe.'
                : 'Finding where you left off…'}
            </p>
            {failure && (
              <Action
                onClick={() => {
                  void profiles.refetch();
                  void providers.refetch();
                  void gateway.refetch();
                }}
              >
                Try again
              </Action>
            )}
          </div>
        ) : (
          <>
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              Step {current + 1} of {steps.length}. {titles[step]}
            </div>
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-8 md:px-12 md:py-10">
              <AnimatePresence mode="wait" initial={false}>
                <Scene key={step} step={step} still={still}>
                  {step === 'intro' && (
                    <WelcomeIntro
                      still={still}
                      begin={() => {
                        if (!connected) setModelsVisited(true);
                        setStep(connected ? 'identity' : 'models');
                      }}
                    />
                  )}
                  {step === 'models' && (
                    <div className="mx-auto grid w-full max-w-xl gap-6">
                      <p className="text-center text-sm leading-relaxed text-muted">
                        Connect a provider to bring your agent to life.
                        <br />
                        Your credentials stay on your gateway.
                      </p>
                      <Suspense fallback={<p role="status">Reading providers…</p>}>
                        <ProviderConnections />
                      </Suspense>
                      <div className="flex items-center justify-end gap-3">
                        <Action
                          tone="primary"
                          disabled={!connected}
                          onClick={() => setStep('identity')}
                        >
                          Continue <ArrowRight size={15} aria-hidden="true" />
                        </Action>
                      </div>
                    </div>
                  )}
                  {step === 'identity' &&
                    (!newAgent && profiles.data?.length ? (
                      <ExistingAgent
                        agents={profiles.data}
                        create={() => setNewAgent(true)}
                        select={(agent) => {
                          onCreated(agent);
                          setStep('arrival');
                        }}
                      />
                    ) : (
                      <WelcomeIdentity
                        draft={draft}
                        change={setDraft}
                        busy={busy}
                        error={error}
                        create={() => void create(draft)}
                      />
                    ))}
                  {step === 'channels' && saved && server && (
                    <WelcomeChannels profileId={saved.id} finish={() => setStep('arrival')} />
                  )}
                  {step === 'arrival' && saved && (
                    <Arrival profile={saved} still={still} finish={finish} />
                  )}
                </Scene>
              </AnimatePresence>
            </div>
            <footer className="sticky bottom-0 z-10 mx-auto flex w-full max-w-6xl shrink-0 flex-wrap items-center justify-between gap-5 border-t border-glass-edge bg-canvas/95 px-6 py-4 backdrop-blur-lg md:px-12">
              <div className="min-w-16">
                {(step === 'models' || step === 'identity') && (
                  <Action
                    tone="quiet"
                    disabled={busy}
                    onClick={() => {
                      if (step === 'identity' && newAgent && profiles.data?.length)
                        setNewAgent(false);
                      else setStep(step === 'identity' && !connected ? 'models' : 'intro');
                    }}
                  >
                    <ArrowLeft size={14} aria-hidden="true" /> Back
                  </Action>
                )}
              </div>
              <ol
                aria-label="Welcome progress"
                className="flex flex-wrap items-center gap-3 text-[11px] text-muted"
              >
                {steps.map((item, index) => (
                  <li
                    key={item}
                    aria-current={item === step ? 'step' : undefined}
                    className={`flex items-center gap-1.5 ${item === step ? 'text-ink' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ${item === step ? 'w-5 bg-ink' : index < current ? 'w-1.5 bg-ink/50' : 'w-1.5 bg-ink/15'}`}
                    />
                    <span className={item === step ? '' : 'hidden sm:inline'}>
                      {
                        {
                          intro: 'Welcome',
                          models: 'Models',
                          identity: 'Your agent',
                          channels: 'Connect',
                          arrival: 'Ready',
                        }[item]
                      }
                    </span>
                  </li>
                ))}
              </ol>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

/** Focus moves only when a scene mounts, never on a preview update or a provider poll. */
function Scene({ step, still, children }: { step: Step; still: boolean; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <motion.section
      className="grid gap-8"
      initial={{ opacity: 0, y: still ? 0 : 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: still ? 0 : -12 }}
      transition={{ duration: still ? 0.1 : 0.32, ease: settle }}
    >
      <motion.h1
        exit={{ opacity: 0, y: still ? 0 : -8 }}
        transition={{ duration: still ? 0.08 : 0.18 }}
        ref={heading}
        tabIndex={-1}
        className={`mx-auto max-w-2xl text-center text-balance outline-none ${step === 'intro' ? 'sr-only' : 'text-3xl font-semibold tracking-tight'}`}
      >
        {titles[step]}
      </motion.h1>
      {children}
    </motion.section>
  );
}

/** The handoff does not depend on animation events, which reduced motion may suppress. */
function Arrival({
  profile,
  still,
  finish,
}: {
  profile: Profile;
  still: boolean;
  finish: (profile: Profile) => void;
}) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const opening = async () => {
      try {
        // The first chat must replace the hero with a ready composer, not another loading screen.
        await Promise.all([
          client.fetchQuery(queries.sessions(profile.id)),
          client.fetchQuery(queries.projects(profile.id)),
          client.fetchQuery(queries.channels(profile.id)),
          client.fetchQuery(queries.contacts(profile.id)),
          client.fetchQuery(queries.activities(profile.id)),
          client.fetchQuery(queries.groups()),
          client.fetchQuery(queries.modelDefaults()),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, still || attempt > 0 ? 0 : 500);
          }),
        ]);
        if (active) finish(profile);
      } catch {
        if (active)
          setError('Your agent was created, but its chat could not be opened. Try again.');
      }
    };
    void opening();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, finish, profile, still, attempt]);

  return (
    <div className="mx-auto grid w-full max-w-md justify-items-center gap-8 py-6">
      <AgentHero
        name={profile.name}
        avatar={profile.avatar}
        summary={profile.summary}
        handoffId={profile.id}
      />
      <p className="text-center text-sm text-muted">
        Your agent is ready. Say hello, or give it something to do.
      </p>
      {error ? (
        <div className="grid justify-items-center gap-3">
          <p role="alert" className="text-center text-sm text-bad">
            {error}
          </p>
          <Action
            tone="primary"
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Action>
        </div>
      ) : (
        <p role="status" className="text-xs text-muted">
          Opening your first chat…
        </p>
      )}
    </div>
  );
}
