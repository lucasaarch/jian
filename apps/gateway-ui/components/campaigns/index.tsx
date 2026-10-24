'use client';

import { Megaphone, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SalesCampaign, SalesCampaignInput } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { Button, Confirm, Empty, Field, Modal, ResourceRow, SectionHeading } from '../ui';

export function Campaigns({ profile, api, mutate, busy }: SectionProps) {
  const { subscribe } = useWorkspace();
  const [items, setItems] = useState<SalesCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SalesCampaign | 'new'>();
  const [removing, setRemoving] = useState<SalesCampaign>();

  const load = useCallback(() => api.campaigns(profile.id).then(setItems), [api, profile.id]);
  useEffect(() => {
    void load()
      .catch(() => setError('Campaigns could not load.'))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type.startsWith('campaign.')) void load();
      }),
    [subscribe, load],
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
    if (ok) await load();
    return ok;
  };

  return (
    <>
      <SectionHeading
        title="Campaigns"
        description="Product and offer details the Sales Attendant can use in customer conversations."
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
          Add campaigns with the product, offer, and terms you want the agent to know.
        </Empty>
      ) : (
        <div className="resource-list">
          {items.map((item) => (
            <ResourceRow
              key={item.id}
              id={`campaign-${item.id}`}
              icon={<Megaphone size={20} strokeWidth={1.6} />}
              name={item.name}
              description={item.description}
              facts={[`Updated ${new Date(item.updatedAt).toLocaleDateString()}`]}
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
          ))}
        </div>
      )}
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
          description="The agent will no longer be able to retrieve this campaign."
          confirm={async () => {
            if (
              await mutate(() => api.deleteCampaign(profile.id, removing.id), 'Campaign deleted.')
            ) {
              await load();
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
  return (
    <Modal
      title={campaign ? 'Edit campaign' : 'New campaign'}
      description="Include the product or service, offer, audience, benefits, price, terms, and call to action."
      close={close}
      footer={
        <>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="campaign-form"
            busy={busy}
            disabled={!name.trim() || !description.trim()}
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
          void save({ name: name.trim(), description: description.trim() }).then(
            (ok) => ok && close(),
          );
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
        <Field label="Campaign details" hint="Full details the agent can retrieve when needed.">
          <textarea
            value={description}
            maxLength={12000}
            rows={12}
            onChange={(event) => setDescription(event.target.value)}
            required
          />
        </Field>
      </form>
    </Modal>
  );
}
