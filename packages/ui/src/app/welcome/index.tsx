'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { Suspense, useEffect, useState } from 'react';
import { Action } from '../../kit';
import { AgentHero } from '../../kit/agent-hero';
import type { Profile } from '../../lib/api';
import { useAppearance } from '../../lib/appearance';
import { useCreateProfile } from '../../lib/create-profile';
import { usePhone } from '../../lib/phone';
import { queries } from '../../lib/query/profile';
import { ProviderConnections } from '../settings/providers-page';
import { WelcomeChannels } from './channels';
import { ExistingAgent } from './existing-agent';
import { type IdentityDraft, WelcomeIdentity } from './identity';
import { WelcomeIntro } from './intro';
import { readChat, Scene, SceneColumn, Stage } from './stage';

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
  creating = false,
  cancel,
}: {
  saved?: Profile;
  onCreated: (profile: Profile) => void;
  finish: (profile: Profile) => void;
  /**
   * Only the making of another agent, for an owner already past the introduction: from its
   * identity straight to its first chat, and back to where they were.
   */
  creating?: boolean;
  cancel?: () => void;
}) {
  // A persisted empty cache is not evidence that the gateway is still empty.
  const profiles = useQuery({ ...queries.profiles(), refetchOnMount: 'always' });
  const providers = useQuery({ ...queries.providers(), refetchOnMount: 'always' });
  const gateway = useQuery(queries.gateway());
  const connected = providers.data?.some((provider) => !provider.revokedAt) ?? false;
  const server = gateway.data?.mode !== 'local';
  const [newAgent, setNewAgent] = useState(creating);
  const [modelsVisited, setModelsVisited] = useState(false);
  const [step, setStep] = useState<Step>(creating ? 'identity' : 'intro');
  const [draft, setDraft] = useState<IdentityDraft>({
    name: '',
    summary: '',
    instructions: '',
    avatar: null,
  });
  const { still } = useAppearance();
  const phone = usePhone();
  const { create, busy, error } = useCreateProfile((profile) => {
    onCreated(profile);
    setStep(server && !creating ? 'channels' : 'arrival');
  });
  const steps: Step[] = [
    'intro',
    ...(connected && !modelsVisited ? [] : ['models' as const]),
    'identity',
    ...(server && !creating ? ['channels' as const] : []),
    'arrival',
  ];
  const current = steps.indexOf(step);
  // Making another agent asks nothing of what the gateway says: there is nowhere to resume from.
  const failure = !creating && !saved && (profiles.isError || providers.isError || gateway.isError);
  const ready =
    creating ||
    saved ||
    (profiles.isFetchedAfterMount && providers.isFetchedAfterMount && gateway.data);
  useEffect(() => {
    if (!creating || !cancel) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy && step === 'identity')
        cancel();
    };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [creating, cancel, busy, step]);

  return (
    <Stage label={creating ? 'Create an agent' : 'Welcome to Jian'}>
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
          <SceneColumn>
            {/* The way back from a step, at its corner: the steps themselves carry no footer. */}
            {/* Making another agent is left with Escape, which a phone does not have. */}
            {(step === 'models' || step === 'identity') && (!creating || phone) && (
              <div className="absolute top-2 left-4 md:left-10">
                <Action
                  tone="quiet"
                  disabled={busy}
                  onClick={() => {
                    if (creating) cancel?.();
                    else if (step === 'identity' && newAgent && profiles.data?.length)
                      setNewAgent(false);
                    else setStep(step === 'identity' && !connected ? 'models' : 'intro');
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" /> Back
                </Action>
              </div>
            )}
            <AnimatePresence mode="wait" initial={false}>
              <Scene key={step} title={titles[step]} hiddenTitle={step === 'intro'} still={still}>
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
                  <div className="mx-auto grid w-full max-w-2xl gap-[clamp(1rem,3dvh,1.5rem)]">
                    <p className="text-center text-sm leading-relaxed text-muted">
                      Connect a provider to bring your agent to life.
                      <br />
                      Your credentials stay on your gateway.
                    </p>
                    <Suspense fallback={<p role="status">Reading providers…</p>}>
                      <ProviderConnections tiles />
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
          </SceneColumn>
        </>
      )}
    </Stage>
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
          ...readChat(client, profile.id),
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
