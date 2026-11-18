'use client';

import { ArrowLeft, Code, Copy, Download, Eye } from 'lucide-react';
import { type RefObject, useState } from 'react';
import { HoverTip, iconButton, SelectButton, SkeletonLine, SkeletonRegion } from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { useGatewayMode } from '../../../lib/gateway-mode';
import { useCrew } from '../../../lib/stores/crew';
import { CodeBlock } from '../../ui/code-block';
import { InspectorBar, InspectorBody } from '../inspector';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactSharing } from './artifact-sharing';
import { copy, download, fileName, LANGUAGE } from './source';
import { type ArtifactsApi, useArtifactVersion } from './use-artifacts';

/**
 * One Artifact in the Inspector: drawn in its sealed frame, or as its source, at the version
 * the owner picks. With none picked it is the latest, and follows the agent's updates. Mount it
 * with the Artifact's id as its key, so another one starts drawn and at its latest.
 */
export function ArtifactView({
  api,
  profileId,
  artifact,
  closer,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  closer: RefObject<HTMLButtonElement | null>;
}) {
  const [picked, setPicked] = useState<number>();
  const [code, setCode] = useState(false);
  // Only a server gateway makes one public, so nothing else offers it; until the gateway says
  // which it is, neither does this.
  const shareable = useGatewayMode() === 'server';
  const version = picked ?? artifact.version;
  const read = useArtifactVersion(api, profileId, artifact.sessionId, artifact.id, version);
  const content = read.data?.content;
  const versions = Array.from({ length: artifact.version }, (_, index) => {
    const number = artifact.version - index;
    return {
      value: String(number),
      label: `Version ${number}`,
      ...(index === 0 ? { detail: 'latest' } : {}),
    };
  });

  return (
    <>
      <InspectorBar
        closer={closer}
        options={
          <>
            <HoverTip tip={code ? 'Show it drawn' : 'View code'} side="bottom" align="end">
              <button
                type="button"
                aria-label="View code"
                aria-pressed={code}
                className={iconButton}
                onClick={() => setCode(!code)}
              >
                {code ? (
                  <Eye size={15} aria-hidden="true" />
                ) : (
                  <Code size={15} aria-hidden="true" />
                )}
              </button>
            </HoverTip>
            <HoverTip tip="Copy source" side="bottom" align="end">
              <button
                type="button"
                aria-label="Copy source"
                disabled={content === undefined}
                className={iconButton}
                onClick={() => content !== undefined && void copy(content, 'Source')}
              >
                <Copy size={14} aria-hidden="true" />
              </button>
            </HoverTip>
            <HoverTip tip="Download" side="bottom" align="end">
              <button
                type="button"
                aria-label="Download"
                disabled={content === undefined}
                className={iconButton}
                onClick={() =>
                  content !== undefined && download(fileName(artifact, version), content)
                }
              >
                <Download size={15} aria-hidden="true" />
              </button>
            </HoverTip>
            {shareable && <ArtifactSharing api={api} profileId={profileId} artifact={artifact} />}
          </>
        }
      >
        <HoverTip tip="All artifacts" hoverOnly side="bottom">
          <button
            type="button"
            aria-label="All artifacts"
            className={iconButton}
            onClick={() => useCrew.getState().showArtifacts()}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
        </HoverTip>
        <h2 className="min-w-0 truncate text-[13px] font-medium text-ink">{artifact.title}</h2>
        <SelectButton
          label="Version"
          value={String(version)}
          options={versions}
          onValueChange={(next) =>
            setPicked(Number(next) === artifact.version ? undefined : Number(next))
          }
        >
          v{version}
        </SelectButton>
      </InspectorBar>

      {read.isError ? (
        <p role="alert" className="px-(--inspector-inset) pt-3 text-sm text-muted">
          {read.error instanceof Error ? read.error.message : 'The Artifact could not be read.'}
        </p>
      ) : !read.data ? (
        <SkeletonRegion
          label="Loading artifact…"
          className="grid gap-2 px-(--inspector-inset) pt-3"
        >
          {['w-1/3', 'w-1/2', 'w-2/5'].map((width) => (
            <SkeletonLine key={width} className={width} />
          ))}
        </SkeletonRegion>
      ) : code ? (
        <InspectorBody className="px-(--inspector-inset)">
          <CodeBlock text={read.data.content} language={LANGUAGE[artifact.type]} wrapped />
        </InspectorBody>
      ) : (
        <ArtifactFrame
          key={version}
          type={artifact.type}
          title={artifact.title}
          source={read.data.compiled ?? read.data.content}
        />
      )}
    </>
  );
}
