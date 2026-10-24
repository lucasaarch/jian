'use client';

import { BarChart3, Megaphone, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SalesCampaign, SalesCampaignInput, SalesCampaignReport } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import {
  Badge,
  Button,
  Confirm,
  Empty,
  Field,
  Modal,
  ResourceRow,
  SectionHeading,
  Switch,
} from '../ui';
import { Select } from '../ui/select';

const periods = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const today = () => new Date().toISOString().slice(0, 10);
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

export function Campaigns({ profile, api, mutate, busy }: SectionProps) {
  const { subscribe } = useWorkspace();
  const [items, setItems] = useState<SalesCampaign[]>([]);
  const [report, setReport] = useState<SalesCampaignReport>();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SalesCampaign | 'new'>();
  const [removing, setRemoving] = useState<SalesCampaign>();

  const load = useCallback(() => api.campaigns(profile.id).then(setItems), [api, profile.id]);
  const loadReport = useCallback(
    () => api.campaignReport(profile.id, days).then(setReport),
    [api, days, profile.id],
  );

  useEffect(() => {
    void Promise.all([load(), loadReport()])
      .catch(() => setError('Campaigns and their report could not load.'))
      .finally(() => setLoading(false));
  }, [load, loadReport]);

  useEffect(
    () =>
      subscribe((event) => {
        if (!event.type.startsWith('campaign.')) return;
        void load();
        void loadReport();
      }),
    [subscribe, load, loadReport],
  );

  const save = async (input: SalesCampaignInput) => {
    const current = editing;
    if (!current) return false;
    const ok = await mutate(
      () =>
        current === 'new'
          ? api.createCampaign(profile.id, input)
          : api.updateCampaign(profile.id, current.id, input),
      current === 'new' ? 'Campaign created.' : 'Campaign saved.',
    );
    if (ok) await Promise.all([load(), loadReport()]);
    return ok;
  };

  const totals = (report?.campaigns ?? []).reduce(
    (sum, item) => ({
      lookups: sum.lookups + item.lookups,
      qualified: sum.qualified + item.qualified,
      notQualified: sum.notQualified + item.notQualified,
      escalated: sum.escalated + item.escalated,
    }),
    { lookups: 0, qualified: 0, notQualified: 0, escalated: 0 },
  );
  const hasActivity = Object.values(totals).some((count) => count > 0);

  return (
    <>
      <SectionHeading
        title="Campaigns"
        description="Product rules and conversation playbooks the Sales Attendant can use with customers."
        action={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} /> New campaign
          </Button>
        }
      />
      {error && (
        <p role="alert" className="row-error">
          {error}
        </p>
      )}
      {!loading && items.length === 0 ? (
        <Empty title="No campaigns yet">
          Add product facts, eligibility rules, and a conversation playbook for the agent.
        </Empty>
      ) : (
        <div className="resource-list">
          {items.map((item) => {
            const active =
              item.active &&
              (!item.startsOn || item.startsOn <= today()) &&
              (!item.endsOn || item.endsOn >= today());
            const state = !item.active
              ? 'Paused'
              : item.startsOn && item.startsOn > today()
                ? 'Scheduled'
                : item.endsOn && item.endsOn < today()
                  ? 'Expired'
                  : 'Active';

            return (
              <ResourceRow
                key={item.id}
                id={`campaign-${item.id}`}
                icon={<Megaphone size={20} strokeWidth={1.6} />}
                name={item.name}
                badges={<Badge tone={active ? 'good' : 'neutral'}>{state}</Badge>}
                description={item.description}
                facts={[
                  ...(item.startsOn || item.endsOn
                    ? [`Valid ${item.startsOn ?? 'anytime'} – ${item.endsOn ?? 'no end date'}`]
                    : []),
                  `Updated ${new Date(item.updatedAt).toLocaleDateString()}`,
                ]}
                actions={
                  <>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit ${item.name}`}
                      onClick={() => setEditing(item)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${item.name}`}
                      onClick={() => setRemoving(item)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                }
              />
            );
          })}
        </div>
      )}

      <section className="stat-section" aria-labelledby="campaign-report-heading">
        <header>
          <h2 id="campaign-report-heading">Sales report</h2>
          <Select
            aria-label="Report period"
            value={String(days)}
            options={periods}
            onValueChange={(value) => setDays(Number(value) as 7 | 30 | 90)}
          />
        </header>
        <p className="stat-since">
          Aggregate campaign activity from {report?.since ?? '…'} through {report?.through ?? '…'}.
          Counts are tool calls, not unique people. No customer identities, answers, or conversation
          text are stored in this report.
        </p>
        {report && !hasActivity ? (
          <Empty title="No activity in this period">
            Campaign lookups and outcomes will appear here as the agent works.
          </Empty>
        ) : (
          <div className="resource-list">
            {report?.campaigns.map((item) => {
              const outcomes = item.qualified + item.notQualified;
              const rate = outcomes ? Math.round((item.qualified / outcomes) * 100) : 0;
              return (
                <ResourceRow
                  key={item.campaignId ?? 'general'}
                  id={`campaign-report-${item.campaignId ?? 'general'}`}
                  icon={<BarChart3 size={20} strokeWidth={1.6} />}
                  name={item.campaignName}
                  description={`${item.lookups} campaign retrievals`}
                  facts={[
                    `${item.qualified} qualified`,
                    `${item.notQualified} not qualified`,
                    `${item.escalated} escalated`,
                    `${rate}% qualification rate`,
                  ]}
                />
              );
            })}
          </div>
        )}
      </section>

      {editing && (
        <CampaignEditor
          campaign={editing === 'new' ? undefined : editing}
          busy={busy}
          close={() => setEditing(undefined)}
          save={save}
        />
      )}
      {removing && (
        <Confirm
          title={`Delete ${removing.name}?`}
          description="The agent will no longer be able to retrieve this campaign. Its aggregate report counts are kept."
          confirm={async () => {
            if (
              await mutate(() => api.deleteCampaign(profile.id, removing.id), 'Campaign deleted.')
            ) {
              await Promise.all([load(), loadReport()]);
              setRemoving(undefined);
            }
          }}
          close={() => setRemoving(undefined)}
          busy={busy}
        />
      )}
    </>
  );
}

function CampaignEditor({
  campaign,
  busy,
  close,
  save,
}: {
  campaign?: SalesCampaign;
  busy: boolean;
  close: () => void;
  save: (input: SalesCampaignInput) => Promise<boolean>;
}) {
  const [name, setName] = useState(campaign?.name ?? '');
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [rules, setRules] = useState<SalesCampaign['rules']>(
    campaign?.rules ?? {
      productOrService: '',
      offer: '',
      price: '',
      audience: '',
      benefits: '',
      eligibility: '',
      terms: '',
      callToAction: '',
    },
  );
  const [playbook, setPlaybook] = useState<SalesCampaign['playbook']>(
    campaign?.playbook ?? {
      opening: '',
      discoveryQuestions: [],
      qualificationCriteria: [],
      objectionHandling: '',
      closing: '',
    },
  );
  const [active, setActive] = useState(campaign?.active ?? true);
  const [startsOn, setStartsOn] = useState(campaign?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.endsOn ?? '');

  return (
    <Modal
      title={campaign ? 'Edit campaign' : 'New campaign'}
      description="Set factual offer rules and a repeatable conversation flow. Qualification stays in the current conversation."
      close={close}
      wide
      footer={
        <>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="campaign-form"
            busy={busy}
            disabled={
              !name.trim() ||
              !description.trim() ||
              Boolean(startsOn && endsOn && startsOn > endsOn)
            }
          >
            {campaign ? 'Save' : 'Create campaign'}
          </Button>
        </>
      }
    >
      <form
        id="campaign-form"
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            name: name.trim(),
            description: description.trim(),
            rules,
            playbook,
            active,
            startsOn: startsOn || null,
            endsOn: endsOn || null,
          }).then((ok) => ok && close());
        }}
      >
        <Field label="Campaign name">
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label="Full campaign description" hint="Context the agent can retrieve when needed.">
          <textarea
            value={description}
            maxLength={12000}
            rows={5}
            onChange={(event) => setDescription(event.target.value)}
            required
          />
        </Field>

        <h3>Offer rules</h3>
        <Field label="Product or service">
          <textarea
            value={rules.productOrService}
            rows={2}
            onChange={(event) => setRules({ ...rules, productOrService: event.target.value })}
          />
        </Field>
        <Field label="Offer">
          <textarea
            value={rules.offer}
            rows={2}
            onChange={(event) => setRules({ ...rules, offer: event.target.value })}
          />
        </Field>
        <Field label="Price">
          <input
            value={rules.price}
            maxLength={500}
            onChange={(event) => setRules({ ...rules, price: event.target.value })}
          />
        </Field>
        <Field label="Intended audience">
          <textarea
            value={rules.audience}
            rows={2}
            onChange={(event) => setRules({ ...rules, audience: event.target.value })}
          />
        </Field>
        <Field label="Benefits">
          <textarea
            value={rules.benefits}
            rows={2}
            onChange={(event) => setRules({ ...rules, benefits: event.target.value })}
          />
        </Field>
        <Field label="Eligibility">
          <textarea
            value={rules.eligibility}
            rows={2}
            onChange={(event) => setRules({ ...rules, eligibility: event.target.value })}
          />
        </Field>
        <Field label="Terms and exclusions">
          <textarea
            value={rules.terms}
            rows={3}
            onChange={(event) => setRules({ ...rules, terms: event.target.value })}
          />
        </Field>
        <Field label="Call to action">
          <textarea
            value={rules.callToAction}
            rows={2}
            onChange={(event) => setRules({ ...rules, callToAction: event.target.value })}
          />
        </Field>

        <h3>Conversation playbook</h3>
        <Field label="Opening">
          <textarea
            value={playbook.opening}
            rows={2}
            onChange={(event) => setPlaybook({ ...playbook, opening: event.target.value })}
          />
        </Field>
        <Field
          label="Discovery questions"
          hint="One question per line. The agent asks one at a time and keeps answers in the current conversation only."
        >
          <textarea
            value={playbook.discoveryQuestions.join('\n')}
            rows={4}
            onChange={(event) =>
              setPlaybook({ ...playbook, discoveryQuestions: lines(event.target.value) })
            }
          />
        </Field>
        <Field
          label="Qualification criteria"
          hint="One criterion per line. Do not include customer data here."
        >
          <textarea
            value={playbook.qualificationCriteria.join('\n')}
            rows={4}
            onChange={(event) =>
              setPlaybook({ ...playbook, qualificationCriteria: lines(event.target.value) })
            }
          />
        </Field>
        <Field label="Objection handling">
          <textarea
            value={playbook.objectionHandling}
            rows={4}
            onChange={(event) =>
              setPlaybook({ ...playbook, objectionHandling: event.target.value })
            }
          />
        </Field>
        <Field label="Closing step">
          <textarea
            value={playbook.closing}
            rows={2}
            onChange={(event) => setPlaybook({ ...playbook, closing: event.target.value })}
          />
        </Field>

        <div className="flex items-center justify-between gap-4">
          <span>Campaign is active</span>
          <Switch checked={active} onChange={setActive} label="Campaign is active" />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Starts on">
            <input
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </Field>
          <Field label="Ends on">
            <input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
